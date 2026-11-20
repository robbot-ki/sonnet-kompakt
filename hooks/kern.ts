// Pure core of the sonnet-kompakt mod, no imports, so node:test can probe it
// without the engine. It turns a long transcript into a short excerpt for a
// smaller model than the session's (Claude Sonnet 5.5) and assembles the
// message that replaces the transcript.

export type Nachricht = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: { tool_use_id?: string; tool: string; input: Record<string, unknown>; text?: string; isError?: true }[]
  toolResults?: { tool_use_id?: string; text?: string; isError?: boolean }[]
}

// Characters per token on these excerpts, measured with Sonnet 5.5:
// two calls over the first 20,000 and 60,000 characters of a real excerpt
// differed by 20,457 input tokens, so 40,000 / 20,457 = 1.96 (the base load
// both calls carried cancels out). Second way: the old 3.2 had put a test
// session at 93k where the engine counted about 160k, which 2.0
// explains. 300,000 characters are thus about 150k tokens: room under a 200k
// window for the instructions and MAX_AUSGABE.
export const BUDGET_ZEICHEN = 300_000
export const ZEICHEN_JE_TOKEN = 2.0

const ERINNERUNG = /<system-reminder>[\s\S]*?<\/system-reminder>/g

export function bereinigt(text: string): string {
  return text.replace(ERINNERUNG, '').replace(/\n{3,}/g, '\n\n').trim()
}

function kappe(text: string, max: number): string {
  if (text.length <= max) return text
  const kopf = Math.floor(max * 0.7)
  return text.slice(0, kopf) + ` […${text.length - max} Zeichen gekürzt…] ` + text.slice(text.length - (max - kopf))
}

function kurz(v: unknown, max = 140): string {
  const s = typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v)
  return s.replace(/\s+/g, ' ').slice(0, max)
}

export function werkzeugZeile(t: { tool: string; input: Record<string, unknown>; isError?: true }): string {
  const i = t.input ?? {}
  let was: string
  if (typeof i.file_path === 'string') was = i.file_path
  else if (t.tool === 'Bash' || t.tool === 'PowerShell') was = kurz(i.description) || kurz(i.command)
  else if (t.tool === 'Agent') was = kurz(i.description) || kurz(i.prompt, 80)
  else if (typeof i.pattern === 'string') was = kurz(i.pattern)
  else if (typeof i.url === 'string') was = kurz(i.url)
  else was = kurz(Object.values(i)[0], 100)
  return `  → ${t.tool}: ${was}${t.isError ? ' (Fehler)' : ''}`
}

function block(m: Nachricht, max: number): string {
  if (m.role === 'user') {
    const zeilen: string[] = []
    const t = bereinigt(m.text)
    if (t) zeilen.push('### Mensch\n' + kappe(t, max))
    for (const r of m.toolResults ?? []) if (r.isError && r.text) zeilen.push('  ⚠ Werkzeugfehler: ' + kurz(r.text, 200))
    return zeilen.join('\n')
  }
  const zeilen: string[] = []
  const t = bereinigt(m.text)
  if (t) zeilen.push('### Claude\n' + kappe(t, Math.floor(max * 0.8)))
  for (const u of m.toolUses ?? []) zeilen.push(werkzeugZeile(u))
  return zeilen.join('\n')
}

// The excerpt the model reads: prompts and answers, one line per tool call, tool
// output dropped (it is most of a transcript's bulk). Newer rows keep more.
export function auszug(liste: readonly Nachricht[], budget = BUDGET_ZEICHEN): string {
  const neu = Math.floor(liste.length * 0.85)
  // Older answers get the most room the budget allows: the excerpt of
  // a real session used 136k of 300k characters yet cut every older answer at
  // 1,200, which is where the summaries lost the order of events.
  for (const alt of [6000, 1500, 400, 120]) {
    const teile = liste.map((m, i) => block(m, i >= neu ? 6000 : alt)).filter(Boolean)
    const ganz = teile.join('\n\n')
    if (ganz.length <= budget) return ganz
    if (alt === 120) {
      const luecke = '\n\n[… mittlerer Teil des Verlaufs ausgelassen, zu lang …]\n\n'
      const kopf = Math.floor(budget * 0.25)
      return ganz.slice(0, kopf) + luecke + ganz.slice(ganz.length - (budget - kopf - luecke.length))
    }
  }
  return ''
}

// Files the session wrote or edited, newest last, each once.
export function dateien(liste: readonly Nachricht[], max = 80): string[] {
  const reihe: string[] = []
  for (const m of liste) for (const u of m.toolUses ?? []) {
    if (!['Write', 'Edit', 'NotebookEdit'].includes(u.tool) || u.isError) continue
    const p = u.input?.file_path ?? u.input?.notebook_path
    if (typeof p !== 'string') continue
    const alt = reihe.indexOf(p)
    if (alt >= 0) reihe.splice(alt, 1)
    reihe.push(p)
  }
  return reihe.slice(-max)
}

// The last prompts and answers word for word, so the next turn starts exactly
// where the conversation stood, whatever the summary missed.
export function zuletzt(liste: readonly Nachricht[], prompts = 3, antworten = 2, max = 4000): string {
  const out: string[] = []
  let p = 0
  let a = 0
  for (let i = liste.length - 1; i >= 0 && (p < prompts || a < antworten); i--) {
    const m = liste[i]
    if (!m) continue
    const t = bereinigt(m.text)
    if (!t) continue
    if (m.role === 'user' && p < prompts) { out.unshift('### Mensch\n' + kappe(t, max)); p++ }
    else if (m.role === 'assistant' && a < antworten) { out.unshift('### Claude\n' + kappe(t, max)); a++ }
  }
  return out.join('\n\n')
}

export function schaetzeTokens(zeichen: number): number {
  return Math.round(zeichen / ZEICHEN_JE_TOKEN)
}

// The conversation's size for the toast and the replacement text, tool output
// included: files read are often the biggest part (test session:
// 55k tokens of file output, a few thousand counted without them). A result
// shows up on the assistant's tool use and on the user's tool result row;
// keyed by its id it counts once.
export function verlaufTokens(liste: readonly Nachricht[]): number {
  let zeichen = 0
  const ergebnis = new Map<string, number>()
  let ohneId = 0
  for (const m of liste) {
    zeichen += m.text.length
    for (const u of m.toolUses ?? []) {
      const n = u.text?.length ?? 0
      if (u.tool_use_id) ergebnis.set(u.tool_use_id, Math.max(ergebnis.get(u.tool_use_id) ?? 0, n))
      else ohneId += n
    }
    for (const r of m.toolResults ?? []) {
      const n = r.text?.length ?? 0
      if (r.tool_use_id) ergebnis.set(r.tool_use_id, Math.max(ergebnis.get(r.tool_use_id) ?? 0, n))
      else ohneId += n
    }
  }
  for (const n of ergebnis.values()) zeichen += n
  return schaetzeTokens(zeichen + ohneId)
}

export const SYSTEM = `Du fasst den Arbeitsverlauf einer langen Claude-Code-Sitzung zusammen. Die Zusammenfassung ersetzt den Verlauf: dieselbe Sitzung arbeitet danach nur mit deinem Text weiter. Was du weglässt, ist für sie verloren.

Schreibe auf Deutsch, knapp und genau, in diesen Abschnitten:
1. Auftrag und Rolle der Sitzung (welches Projekt, welche Art Sitzung, was der Mensch erreichen will)
2. Absprachen und Regeln, die der Mensch in dieser Sitzung gesetzt hat: jede mit seinem Wortlaut in Anführungszeichen, auch wenn es viele sind; überholte Regeln als überholt kennzeichnen
3. Entscheidungen, mit Begründung, wo sie im Verlauf steht
4. Erledigt: was gebaut, geändert, geprüft wurde, mit Dateipfaden, Versionen, Testergebnissen
5. Offen: was angefangen, aber nicht fertig ist, und der nächste konkrete Schritt
6. Fallen und Erkenntnisse: was schiefging und wie es gelöst wurde
7. Wichtige Pfade, Befehle, Kennungen, Zahlen

Regeln: Erfinde nichts. Was im Verlauf unklar bleibt, als unklar kennzeichnen. Pfade, Befehle und Zahlen exakt übernehmen. Namen von Funktionen, Schnittstellen, Dateien und Befehlen nur, wenn sie wörtlich im Verlauf stehen, sonst in Worten beschreiben. Zeitfolge beachten: der spätere Stand gilt; was im Verlauf erledigt wurde (auch Tests und Erinnerungen), steht unter Erledigt, nie unter Offen; Versionen und Uhrzeiten immer beim richtigen Ereignis. Schreibe alle sieben Abschnitte mit den Überschriften „## 1.“ bis „## 7.“, auch wenn einer kurz ausfällt. Keine Einleitung, kein Schlusswort. Höchstens rund 3.500 Wörter.`

export function anfrage(text: string, schwerpunkt: string): string {
  const s = schwerpunkt.trim() ? `\n\nSchwerpunkt, den der Mensch für die Zusammenfassung nennt: ${schwerpunkt.trim()}` : ''
  return `Hier ist der Verlauf, Werkzeug-Ausgaben sind weggelassen, ältere Nachrichten gekürzt:${s}\n\n<verlauf>\n${text}\n</verlauf>`
}

// The reply's token cap. Thinking counts against it: at 12000, 3 of 11 saved
// runs stopped mid-sentence with only 3.7k to 13k
// characters of summary, so the cut came from the cap, not from the text.
export const MAX_AUSGABE = 32_000

// A summary is whole when it reaches the last of the seven sections and the
// reply stayed under the cap. The engine reports no stop reason, so this is
// the only way to tell a cut-off reply from a finished one.
export function vollstaendig(text: string, ausgabeTokens: number, max = MAX_AUSGABE): boolean {
  // A heading, not a "7." in a numbered list (Sonnet numbers its open points).
  return ausgabeTokens < max && /^#{1,4}\s*7\.\s/m.test(text)
}

// `gemessen`: the engine's size of the whole context; without it the own
// estimate of the conversation, which runs low on transcript-like text
// (test session: 93k estimated, about 160k real).
export function ersatz(o: { datum: string; tokensVorher: number; gemessen?: boolean; zusammenfassung: string; dateien: string[]; zuletzt: string }): string {
  return [
    `Diese Sitzung wurde am ${o.datum} kompaktiert (Mod sonnet-kompakt). ${o.gemessen ? 'Der frühere Kontext' : 'Der frühere Verlauf'} (rund ${o.tokensVorher.toLocaleString('de-DE')} Tokens${o.gemessen ? '' : ', geschätzt'}) ist ersetzt durch eine Zusammenfassung von Claude Sonnet 5.5 und zwei mechanische Teile. Feinheiten können fehlen: im Zweifel in den genannten Dateien oder in den Projektnotizen nachlesen, nicht raten.`,
    '## Zusammenfassung (Sonnet)\n\n' + o.zusammenfassung.trim(),
    '## Zuletzt geschriebene Dateien (mechanisch, älteste zuerst)\n\n' + (o.dateien.length ? o.dateien.map(d => '- ' + d).join('\n') : '- keine'),
    '## Wörtlich zuletzt (mechanisch)\n\n' + (o.zuletzt || '(nichts)'),
  ].join('\n\n')
}

// sonnet-kompakt: lets Claude Sonnet 5.5 write the summary of a compaction
// instead of the session's own model. A cold 800k session costs the session's
// model a full re-read; Sonnet reads a filtered excerpt for a fraction.
// Successor of an earlier Haiku version: in one blind comparison on the same
// excerpt (one session, one run each) Sonnet kept 96 % of a weighted checklist,
// Haiku 70 %, and 3 of 11 saved Haiku runs were cut off mid-sentence. The
// author chose accuracy over the saving.
//
// How: the engine's own compaction (`/compact`) raises `session.compact`; when
// its instructions start with "sonnet" (or the old "haiku"), this hook answers
// with Sonnet's summary plus the files written and the last messages word for
// word. Plain `/compact` stays the engine's. Three doors start it: `/compact sonnet …`,
// `/kompakt …` and a tile "▰ compress" at the right of the band above the
// prompt (discreet, one word).
// A plugin's own `$.session.compact` does not pass through its own hooks
// (engine test), so the doors run the built-in command instead.
// Never asks for confirmation.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Lauf } from '../types'
import { anfrage, auszug, dateien, ersatz, MAX_AUSGABE, schaetzeTokens, SYSTEM, verlaufTokens, vollstaendig, zuletzt, type Nachricht } from './kern.ts'

// Measured on the WHOLE context as the engine reports it, base load of some
// 95k (instructions, memory) included: that is what a cold cache reads anew,
// so that is what the threshold weighs (counting the conversation alone
// missed the files read and left the base load out: the tile stayed hidden
// in a 150k test session). Below it, and when
// the engine gives no size, the tile stays hidden.
const MINDEST_TOKENS = 150_000
// The tile only when the prompt cache is cold, i.e. the last response is over
// an hour old (the prompt-cache lifetime assumed here; adjust it to your plan).
// Found in testing: a fresh project session stood at 168k after four minutes
// of reading, so by size alone the tile showed where compacting only throws
// away what was just read, so it shows only when cold. Unknown time
// (a session from before this rule, or no answer yet) counts as cold: the size
// threshold already keeps a fresh session out. `/kompakt` works either way.
const KALT_NACH_MS = 60 * 60 * 1000
// Very large sessions get the tile while warm too (decision: also when warm):
// every message of a session that size costs and slows noticeably even from a
// warm cache, and answers lose precision. 400k is a starting value, not a
// measurement; check it against real sessions and adjust.
const GROSS_TOKENS = 400_000
const ANTWORT_KEY = (id: string) => `antwort:${id}`
// The engine refuses a compaction started inside a command's own dispatch
// (engine test); a short wait lets that dispatch end first.
const STARTEN_NACH_MS = 200
// "haiku" stays a door so the old habit `/compact haiku` still lands here and
// not in the engine's own (session-model) summary.
const MARKE = /^\s*(?:sonnet|haiku)\b\s*/i
const MODELL = 'sonnet'
// A provider ends a whole-reply request at ten minutes; Sonnet writing up to
// MAX_AUSGABE tokens needs more than the five minutes Haiku had.
const ZEIT_MS = 9 * 60 * 1000
// The tile: one English word.
const KACHEL = '▰ '
const LABEL = 'compress'
// Calm blue from the app's theme: yellow and red already
// mean "tight" and "critical" in the band, green is the "all well" light;
// blue reads as "you can act here". A theme key follows light and dark modes.
// It colours the tile glyph BESIDE the button: the desktop draws its native
// button and ignores a coloured text inside it (seen on the desktop app).
const FARBE = 'suggestion'
// Columns kept free for the tile beside the other lines: its gap, the label
// and up to four cells of button chrome (the terminal may frame a button as
// "[ label ]"; reserving the frame never costs more than a narrower line).
const MARGE = 2
const KNOPF_RAHMEN = 4

const lauf = atom({ plugin: 'sonnet-kompakt', key: 'lauf' } as const, null)
const kontext = atom({ plugin: 'sonnet-kompakt', key: 'kontext' } as const, null)
const antwort = atom({ plugin: 'sonnet-kompakt', key: 'antwort' } as const, null)

const tausend = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

// Module state: a reload starts it over, a half-done run does not survive one.
let laeuft = false

// Checks the size, then starts the built-in /compact with the marker. Returns
// what to tell the person.
async function starte($: EngineInterface, schwerpunkt: string, erzwingen: boolean): Promise<string> {
  const groesse = await read($, kontext)
  if (!erzwingen && groesse === null) {
    return 'sonnet-kompakt: Die Größe des Kontexts ist noch unbekannt (kommt mit der nächsten Antwort). Mit „/kompakt jetzt“ trotzdem.'
  }
  if (!erzwingen && groesse !== null && groesse < MINDEST_TOKENS) {
    return `sonnet-kompakt: Der Kontext hat erst rund ${tausend(groesse)} Tokens, das lohnt sich noch nicht (ab ${tausend(MINDEST_TOKENS)}). Mit „/kompakt jetzt“ trotzdem.`
  }
  $.clock.after(STARTEN_NACH_MS, () => { void $.command.run({ command: 'compact', args: `sonnet ${schwerpunkt}`.trim() }) })
  return `sonnet-kompakt: Sonnet fasst den Verlauf zusammen${groesse !== null ? ` (Kontext rund ${tausend(groesse)} Tokens)` : ''} …`
}

async function zusammenfassen($: EngineInterface, liste: readonly Nachricht[], schwerpunkt: string): Promise<{ text: string } | { skip: string }> {
  // The engine's figure when it has one: the own count runs low .
  const gemessen = await read($, kontext)
  const vorher = gemessen ?? verlaufTokens(liste)
  const art = gemessen !== null ? 'Kontext' : 'Verlauf (geschätzt)'
  const text = auszug(liste)
  await update($, lauf, (): Lauf => ({ zustand: 'liest', text: `Sonnet liest ${tausend(schaetzeTokens(text.length))} …` }))
  const r = await $.model.complete({ model: MODELL, system: SYSTEM, prompt: anfrage(text, schwerpunkt), maxTokens: MAX_AUSGABE, timeoutMs: ZEIT_MS })
  if (!r.isAnswered) {
    // No fall back to the session's model: that is the expensive read this mod avoids.
    const grund = `${r.reason}${'status' in r && r.status ? ' ' + r.status : ''}`
    await update($, lauf, (): Lauf => ({ zustand: 'fehler', text: `Sonnet ohne Antwort (${grund})` }))
    return { skip: `sonnet-kompakt: Sonnet hat nicht geantwortet (${grund}). Der Verlauf ist unverändert.` }
  }
  // A cut-off summary would silently replace the history with half of it.
  if (!vollstaendig(r.text, r.usage.output_tokens)) {
    await update($, lauf, (): Lauf => ({ zustand: 'fehler', text: 'Zusammenfassung abgeschnitten' }))
    return { skip: `sonnet-kompakt: Die Zusammenfassung brach vor dem letzten Abschnitt ab (${tausend(r.usage.output_tokens)} Ausgabe-Tokens). Der Verlauf ist unverändert.` }
  }

  const datum = new Date(await $.clock.now()).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  const neu = ersatz({ datum, tokensVorher: vorher, gemessen: gemessen !== null, zusammenfassung: r.text, dateien: dateien(liste), zuletzt: zuletzt(liste) })

  // Keep a copy outside the session: a compaction cannot be undone in it.
  const heim = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  const sicherung = `${heim.replace(/\\/g, '/')}/.claude/sonnet-kompakt/${datum.slice(0, 10)}_${await $.session.id()}.md`
  try { await $.fs.write(sicherung, neu) } catch { /* the compaction still runs; the summary is in the session */ }

  const nachher = schaetzeTokens(neu.length)
  // The engine's next measure gives the new size; until then no tile.
  await update($, kontext, () => null)
  await update($, lauf, (): Lauf => ({ zustand: 'fertig', text: `${tausend(vorher)} → Zusammenfassung ${tausend(nachher)}` }))
  const gelesen = r.usage.input_tokens + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0)
  $.ui.toast(`sonnet-kompakt: ${art} ${tausend(vorher)} → Zusammenfassung rund ${tausend(nachher)} Tokens, dazu die Grundlast (Sonnet las ${tausend(gelesen)}). Kopie: ${sicherung}`, { timeoutMs: 10000 })
  return { text: neu }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'kompakt', description: 'Verlauf von Sonnet zusammenfassen lassen (genau, ohne Opus), wie /compact sonnet. Optional: Schwerpunkt; „jetzt“ auch bei kleinem Verlauf' })
    // A reopened cold session: the engine knows the size before the first message.
    const u = await $.session.usage()
    await update($, kontext, () => u.context.tokens ?? null)
    // When this session last answered, kept across restarts of the app.
    const zuletzt = (await $.store.get(ANTWORT_KEY(await $.session.id()))) as number | undefined
    await update($, antwort, () => zuletzt ?? null)
    return next(e)
  })

  // The result stays next to the tile until the next response, then goes.
  on('session.measure', async ($, e, next) => {
    // A measure of the rate limits alone leaves the known size standing.
    if (e.context.tokens !== undefined) {
      await update($, kontext, () => e.context.tokens ?? null)
      // A context size comes with a response: the cache is warm again from now.
      const jetzt = await $.clock.now()
      await update($, antwort, () => jetzt)
      await $.store.set(ANTWORT_KEY(await $.session.id()), jetzt)
    }
    const l = await read($, lauf)
    if (l !== null && l.zustand !== 'liest') await update($, lauf, () => null)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute' || !MARKE.test(e.instructions ?? '') || laeuft) return next(e)
    laeuft = true
    try {
      const r = await zusammenfassen($, e.messages, (e.instructions ?? '').replace(MARKE, ''))
      if ('skip' in r) return { skip: r.skip }
      return { messages: [{ role: 'user', text: r.text, toolUses: [] }] }
    } finally {
      laeuft = false
    }
  })

  on('command.run', { command: 'kompakt' }, async ($, e) => {
    const worte = e.args.trim()
    return { text: await starte($, worte.replace(/^jetzt\b\s*/i, ''), /^jetzt\b/i.test(worte)) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const l = await read($, lauf)
    const groesse = await read($, kontext)
    const { Box, Button, Text } = $.ui.resolve(e)
    // No tile while Claude works (compacting under a running turn would cut the
    // ground from under it) and none below the threshold. While Sonnet reads,
    // the tile shows that instead; afterwards the result until the next answer.
    const zuletzt = await read($, antwort)
    const kalt = zuletzt === null || (await $.clock.now()) - zuletzt >= KALT_NACH_MS
    const g = groesse ?? 0
    const knopf = g >= MINDEST_TOKENS && (kalt || g >= GROSS_TOKENS) && l?.zustand !== 'liest' && !e.props.isWorking
    const status = l === null ? '' : l.zustand === 'liest' ? `▰ ${l.text}` : `${l.text}  `
    const kachel = !knopf && status === ''
      ? null
      : (
        <Box>
          {status !== '' ? <Text dimColor={l?.zustand !== 'fehler'} color={l?.zustand === 'fehler' ? 'red' : undefined}>{status}</Text> : null}
          {knopf ? (
            <Box>
              <Text color={FARBE}>{KACHEL}</Text>
              <Button key="kompakt" label={LABEL} onPress={() => { void starte($, '', false).then(t => { if (t.includes('lohnt sich noch nicht')) $.ui.toast(t, { timeoutMs: 6000 }) }) }} />
            </Box>
          ) : null}
        </Box>
      )
    if (kachel === null) return next(e)
    // The band draws one tree. Standing first in CLAUDE_CODE_PLUGIN_DIRS this
    // hook is the outermost and gets the other mods' lines (for example a
    // quota or planning band) from `next`: the tile then sits at the right of their
    // last line instead of opening a line of its own (the
    // band should not grow). The lines beneath are told the narrower width, so a
    // full line does not wrap beside the tile.
    const reserve = MARGE + (knopf ? KACHEL.length + LABEL.length + KNOPF_RAHMEN : 0) + status.length
    const unten = await next({ ...e, props: { ...e.props, bodyColumns: Math.max(30, (e.props.bodyColumns ?? 120) - reserve) } })
    return (
      <Box flexDirection="row" alignItems="flex-end">
        <Box flexDirection="column" flexGrow={1}>
          {unten.type === 'engine' ? null : unten}
        </Box>
        <Box marginLeft={MARGE}>{kachel}</Box>
      </Box>
    )
  })
}

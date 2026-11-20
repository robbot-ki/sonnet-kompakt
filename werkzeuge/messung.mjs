// Measures where a sonnet-kompakt run loses information, in two stages:
// (1) mechanically, how much of the transcript reaches the model at all
//     (excerpt budget, dropped tool output, cut middle, the human's prompts kept),
// (2) the excerpt and the request, written to files, so a second model can
//     summarise exactly the same input for a side-by-side comparison.
// Read-only on the transcript. Run:
//   node werkzeuge/messung.mjs <transcript.jsonl> <ausgabeordner>
// Built to compare Sonnet against Haiku on the same excerpt.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { auszug, anfrage, bereinigt, SYSTEM, BUDGET_ZEICHEN, ZEICHEN_JE_TOKEN } from '../hooks/kern.ts'

const [datei, aus] = process.argv.slice(2)
if (!datei || !aus) { console.log('Aufruf: messung.mjs <transcript.jsonl> <ausgabeordner>'); process.exit(1) }
mkdirSync(aus, { recursive: true })

const zeilen = readFileSync(datei, 'utf8').split('\n')
// Only the part before the first sonnet-kompakt boundary: that is what the mod read.
let ende = zeilen.length
for (let i = 0; i < zeilen.length; i++) {
  if (zeilen[i].includes('"compact_boundary"')) { ende = i; break }
}

const liste = []
let zeichenGesamt = 0, zeichenWerkzeug = 0
const textVon = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b.type === 'text' ? b.text : '').join('\n') : ''
for (const z of zeilen.slice(0, ende)) {
  if (!z) continue
  let o; try { o = JSON.parse(z) } catch { continue }
  if (o.type !== 'user' && o.type !== 'assistant') continue
  const c = o.message?.content
  const m = { role: o.type, text: '', toolUses: [], toolResults: [] }
  if (typeof c === 'string') m.text = c
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b.type === 'text') m.text += (m.text ? '\n' : '') + b.text
      else if (b.type === 'tool_use') m.toolUses.push({ tool_use_id: b.id, tool: b.name, input: b.input ?? {} })
      else if (b.type === 'tool_result') {
        const t = textVon(b.content)
        zeichenWerkzeug += t.length
        m.toolResults.push({ tool_use_id: b.tool_use_id, text: t, isError: b.is_error === true })
      }
    }
  }
  zeichenGesamt += m.text.length + m.toolResults.reduce((s, r) => s + (r.text?.length ?? 0), 0)
    + m.toolUses.reduce((s, u) => s + JSON.stringify(u.input).length, 0)
  liste.push(m)
}

const text = auszug(liste)
const mitteFehlt = text.includes('[… mittlerer Teil des Verlaufs ausgelassen')

// The human's own prompts (not tool results, not empty after removing reminders).
const prompts = liste.filter(m => m.role === 'user' && bereinigt(m.text).length > 0 && m.toolResults.length === 0)
let ganz = 0, angeschnitten = 0, fehlt = 0
const fehlende = []
for (const p of prompts) {
  const t = bereinigt(p.text)
  const kopf = t.slice(0, 80)
  if (!text.includes(kopf)) { fehlt++; fehlende.push(kopf.replace(/\s+/g, ' ')); continue }
  if (text.includes(t)) ganz++
  else angeschnitten++
}

writeFileSync(join(aus, 'auszug.txt'), text)
writeFileSync(join(aus, 'system.txt'), SYSTEM)
writeFileSync(join(aus, 'anfrage.txt'), anfrage(text, ''))

const tok = n => Math.round(n / ZEICHEN_JE_TOKEN).toLocaleString('de-DE')
const bericht = [
  `Transkript bis zur Kompaktierung: ${liste.length} Nachrichten, rund ${tok(zeichenGesamt)} Tokens Text`,
  `davon Werkzeug-Ausgaben: rund ${tok(zeichenWerkzeug)} Tokens (${Math.round(100 * zeichenWerkzeug / zeichenGesamt)} %), im Auszug nicht enthalten`,
  `Auszug für das Modell: rund ${tok(text.length)} Tokens (Budget ${tok(BUDGET_ZEICHEN)}), das sind ${(100 * text.length / zeichenGesamt).toFixed(1)} % des Transkripts`,
  `Mittlerer Teil ausgelassen: ${mitteFehlt ? 'ja' : 'nein'}`,
  `Nachrichten des Menschen: ${prompts.length}; ganz im Auszug ${ganz}, gekürzt ${angeschnitten}, fehlen ganz ${fehlt}`,
  ...fehlende.slice(0, 15).map(f => `  fehlt: ${f}`),
].join('\n')
writeFileSync(join(aus, 'bericht.txt'), bericht + '\n')
console.log(bericht)

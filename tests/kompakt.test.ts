// The mod against the engine itself, without network or login: the test's
// hooks stand for the engine's compaction and context size, for Sonnet, for the
// transcript, the files and the built-in /compact command.
// Run: claude plugin test <path to this folder>
import { expect, mock, test } from 'claude-code/testing'

const row = (role: 'user' | 'assistant', text: string, toolUses: { tool_use_id: string; tool: string; input: Record<string, unknown> }[] = []) => ({ role, text, toolUses })

// About 160,000 characters of text (the tool's file content not counted):
// some 80k tokens by the mod's estimate of 2.0 characters per token.
const VERLAUF = [
  row('user', 'Merke dir das Codewort BLAUWAL-7. ' + 'Hintergrund '.repeat(8000)),
  row('assistant', 'Ich schreibe die Notiz.', [{ tool_use_id: 't1', tool: 'Write', input: { file_path: 'C:/x/notiz.md', content: 'y'.repeat(50000) } }]),
  row('assistant', 'Erledigt. ' + 'Bericht '.repeat(8000)),
  row('user', 'Wie geht es weiter?'),
]
// The same plus a file read of 320,000 characters: 100k more tokens of tool output.
const MIT_DATEI = [
  ...VERLAUF.slice(0, 3),
  row('assistant', 'Ich lese die Datei.', [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: 'C:/x/gross.md' } }]),
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'd'.repeat(320_000), isError: false }] },
  VERLAUF[3],
]
const KLEIN = [row('user', 'kurz'), row('assistant', 'ok')]
const START = { cwd: 'C:/x', surface: 'desktop', isInteractive: true } as never
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100 } } as const
const messung = (tokens: number | undefined) => ({ context: { tokens, window: 1_000_000 }, rateLimits: [], changed: ['context'] }) as never

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function welt(on: any, opts: { antwort?: boolean; abgeschnitten?: boolean } = {}) {
  const seen = { modell: '', prompt: '', geschrieben: '', pfad: '', kern: 0, toast: '', compactArgs: [] as string[], verlauf: VERLAUF as unknown[], kontext: 160_000 as number | undefined, uhr: mock.clock(on, { now: Date.UTC(2026, 9, 12, 10, 0) }) }
  mock.env(on, { USERPROFILE: 'C:\\Users\\Test' })
  on('session.id', () => ({ value: 'sitzung-1' }))
  on('session.messages', () => ({ value: seen.verlauf }))
  // The engine's own size of the whole context, base load included.
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: seen.kontext, window: 1_000_000 }, rateLimits: [] } }))
  on('session.measure', ($: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', ($: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  // Beneath the band: the engine draws nothing of its own here.
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('ui.toast', ($: unknown, e: { text: string }) => { seen.toast = e.text; return { value: undefined } })
  on('model.complete', ($: unknown, e: { model: string; prompt: string }) => {
    seen.modell = e.model
    seen.prompt = e.prompt
    const usage = { input_tokens: 5000, output_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: opts.antwort === false ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage } : { isAnswered: true, text: opts.abgeschnitten ? '## 1. Auftrag\nZUSAMMENFASSUNG: Codewort BLAUWAL-7, Notiz geschr' : '## 1. Auftrag\nZUSAMMENFASSUNG: Codewort BLAUWAL-7, Notiz geschrieben.\n## 7. Pfade\n- C:/x/notiz.md', usage } }
  })
  on('fs.write', ($: unknown, e: { path: string; text: string }) => { seen.pfad = e.path; seen.geschrieben = e.text; return { value: undefined } })
  // The engine's own summarizer stands beneath: reached only when the mod passes it on.
  on('session.compact', () => { seen.kern++; return { messages: [row('user', 'Zusammenfassung des Kerns')] } })
  // The built-in /compact: records what it was asked, as the doors call it.
  on('command.run', ($: unknown, e: { command: string; args: string }) => {
    if (e.command === 'compact') seen.compactArgs.push(e.args)
    return { text: '' }
  })
  return seen
}

const text = (r: unknown) => String((r as { text?: string }).text)

test('/compact sonnet: Sonnet schreibt die Zusammenfassung, der Kern-Zusammenfasser läuft nicht', async ($, on) => {
  const seen = welt(on)
  const r = await $.session.compact({ trigger: 'manual', instructions: 'sonnet', messages: VERLAUF } as never)
  expect(seen.kern).toBe(0)
  expect(seen.modell).toBe('sonnet')
  expect(seen.prompt.includes('BLAUWAL-7')).toBe(true)
  expect(seen.prompt.includes('yyyyyyyyyy')).toBe(false)
  const neu = (r as unknown as { messages: { text: string }[] }).messages
  expect(neu.length).toBe(1)
  for (const s of ['ZUSAMMENFASSUNG: Codewort BLAUWAL-7', '- C:/x/notiz.md', '### Mensch\nWie geht es weiter?']) expect(neu[0]!.text.includes(s)).toBe(true)
  // The engine hands the path on in the platform's spelling (backslashes on Windows).
  expect(seen.pfad.replace(/\\/g, '/')).toBe('C:/Users/Test/.claude/sonnet-kompakt/2026-10-12_sitzung-1.md')
  expect(seen.geschrieben).toBe(neu[0]!.text)
  // 50k at the old 3.2 characters per token, so 80k at the measured 2.0.
  expect(seen.toast).toMatch(/Verlauf \(geschätzt\) 80k → Zusammenfassung rund 4k Tokens/)
})

test('gelesene Dateien zählen im Verlauf mit, Sonnet liest sie trotzdem nicht', async ($, on) => {
  const seen = welt(on)
  const r = await $.session.compact({ trigger: 'manual', instructions: 'sonnet', messages: MIT_DATEI } as never)
  expect(seen.toast).toMatch(/Verlauf \(geschätzt\) 240k → Zusammenfassung rund 4k Tokens/)
  expect(seen.prompt.includes('dddddddddd')).toBe(false)
  expect((r as unknown as { messages: { text: string }[] }).messages[0]!.text).toMatch(/Der frühere Verlauf \(rund 240\.\d\d\d Tokens, geschätzt\)/)
})

test('kennt die Engine die Größe, nennt die Zusammenfassung sie statt der Schätzung', async ($, on) => {
  const seen = welt(on)
  seen.kontext = 210_000
  await $.session.start(START)
  const r = await $.session.compact({ trigger: 'manual', instructions: 'sonnet', messages: VERLAUF } as never)
  expect(seen.toast).toMatch(/Kontext 210k → Zusammenfassung rund 4k Tokens, dazu die Grundlast/)
  expect((r as unknown as { messages: { text: string }[] }).messages[0]!.text).toMatch(/Der frühere Kontext \(rund 210\.000 Tokens\)/)
})

test('/compact sonnet mit Schwerpunkt: der Schwerpunkt erreicht Sonnet', async ($, on) => {
  const seen = welt(on)
  await $.session.compact({ trigger: 'manual', instructions: 'Sonnet Fokus Steuer', messages: VERLAUF } as never)
  expect(seen.prompt).toMatch(/Schwerpunkt, den der Mensch für die Zusammenfassung nennt: Fokus Steuer/)
})

test('Sonnet antwortet nicht: Verlauf bleibt, kein teurer Rückfall auf den Kern', async ($, on) => {
  const seen = welt(on, { antwort: false })
  const r = await $.session.compact({ trigger: 'manual', instructions: 'sonnet', messages: VERLAUF } as never)
  expect(seen.kern).toBe(0)
  expect(seen.geschrieben).toBe('')
  expect(String((r as { skip?: string }).skip)).toMatch(/nicht geantwortet \(api-error 529\)/)
})

test('Sonnet bricht vor dem letzten Abschnitt ab: Verlauf bleibt, nichts geschrieben, kein Rückfall', async ($, on) => {
  const seen = welt(on, { abgeschnitten: true })
  const r = await $.session.compact({ trigger: 'manual', instructions: 'sonnet', messages: VERLAUF } as never)
  expect(seen.kern).toBe(0)
  expect(seen.geschrieben).toBe('')
  expect(String((r as { skip?: string }).skip)).toMatch(/brach vor dem letzten Abschnitt ab/)
})

test('die alte Tür /compact haiku landet auch bei Sonnet, nicht beim Kern', async ($, on) => {
  const seen = welt(on)
  await $.session.compact({ trigger: 'manual', instructions: 'haiku Fokus Steuer', messages: VERLAUF } as never)
  expect(seen.kern).toBe(0)
  expect(seen.modell).toBe('sonnet')
  expect(seen.prompt).toMatch(/Schwerpunkt, den der Mensch für die Zusammenfassung nennt: Fokus Steuer/)
})

test('normales /compact und Vorab-Berechnung bleiben beim Kern', async ($, on) => {
  const seen = welt(on)
  await $.session.compact({ trigger: 'manual', messages: VERLAUF } as never)
  await $.session.compact({ trigger: 'manual', instructions: 'fasse kurz', messages: VERLAUF } as never)
  await $.session.compact({ trigger: 'precompute', instructions: 'sonnet', messages: VERLAUF } as never)
  expect(seen.kern).toBe(3)
  expect(seen.modell).toBe('')
})

test('/kompakt ab 150k Kontext: startet kurz danach /compact sonnet, mit Schwerpunkt', async ($, on) => {
  const seen = welt(on)
  seen.verlauf = KLEIN // little text, the engine's size counts
  await $.session.start(START)
  const r = await $.command.run({ command: 'kompakt', args: 'Fokus Steuer' } as never)
  expect(text(r)).toMatch(/Sonnet fasst den Verlauf zusammen \(Kontext rund 160k Tokens\)/)
  expect(seen.compactArgs).toEqual([])
  await seen.uhr.advance(500)
  expect(seen.compactArgs).toEqual(['sonnet Fokus Steuer'])
})

test('/kompakt unter 150k oder ohne bekannte Größe: Hinweis, mit „jetzt“ doch', async ($, on) => {
  const seen = welt(on)
  seen.kontext = 140_000
  await $.session.start(START)
  expect(text(await $.command.run({ command: 'kompakt', args: '' } as never))).toMatch(/erst rund 140k Tokens, das lohnt sich noch nicht \(ab 150k\)/)
  seen.kontext = undefined
  await $.session.start(START)
  expect(text(await $.command.run({ command: 'kompakt', args: '' } as never))).toMatch(/noch unbekannt/)
  await seen.uhr.advance(500)
  expect(seen.compactArgs).toEqual([])
  await $.command.run({ command: 'kompakt', args: 'jetzt' } as never)
  await seen.uhr.advance(500)
  expect(seen.compactArgs).toEqual(['sonnet'])
})

test('Kachel ▰ compress: ganzer Kontext der Engine (160k ja, 140k nein, unbekannt nein), nur bei kaltem Speicher, nie während Claude arbeitet', async ($, on) => {
  // Hooks beneath the plugins go in before the first call on $, so once.
  const seen = welt(on)
  seen.verlauf = KLEIN
  const sieht = async (surface: 'terminal' | 'desktop', isWorking = false) => {
    const ui = await $.ui.mount({ plugin: 'sonnet-kompakt', surface, component: 'AbovePrompt', props: { ...BAND.props, isWorking } } as never)
    const k = await ui.find({ key: 'kompakt' })
    return { ui, k }
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    seen.compactArgs.length = 0
    for (const [groesse, da] of [[140_000, false], [undefined, false], [160_000, true]] as const) {
      seen.kontext = groesse
      await $.session.start(START)
      const { ui, k } = await sieht(surface)
      expect(k === undefined ? 'weg' : k.text).toBe(da ? 'compress' : 'weg')
      await ui.unmount()
    }
    const arbeitet = await sieht(surface, true)
    expect(arbeitet.k).toBeUndefined()
    await arbeitet.ui.unmount()

    // The size also arrives with each response (session.measure), not only at
    // start; a response also warms the cache, so the tile waits an hour.
    seen.kontext = undefined
    await $.session.start(START)
    await $.session.measure(messung(155_000))
    const warm = await sieht(surface)
    expect(warm.k).toBeUndefined()
    await warm.ui.unmount()
    await seen.uhr.advance(59 * 60 * 1000)
    const fast = await sieht(surface)
    expect(fast.k).toBeUndefined()
    await fast.ui.unmount()
    await seen.uhr.advance(2 * 60 * 1000)
    const { ui, k } = await sieht(surface)
    expect(k?.text).toBe('compress')
    await ui.press({ key: 'kompakt' })
    await seen.uhr.advance(500)
    expect(seen.compactArgs).toEqual(['sonnet'])
    await ui.unmount()
  }
})

test('wieder geöffnete Sitzung: die letzte Antwort zählt über den Neustart, warm keine Kachel, nach einer Stunde schon', async ($, on) => {
  const seen = welt(on)
  seen.verlauf = KLEIN
  await $.session.start(START)
  await $.session.measure(messung(160_000))
  const kachel = async () => {
    const ui = await $.ui.mount({ plugin: 'sonnet-kompakt', surface: 'desktop', ...BAND } as never)
    const k = await ui.find({ key: 'kompakt' })
    await ui.unmount()
    return k !== undefined
  }
  await seen.uhr.advance(10 * 60 * 1000)
  await $.session.start(START) // the app reopens it ten minutes later
  expect(await kachel()).toBe(false)
  await seen.uhr.advance(2 * 60 * 60 * 1000)
  await $.session.start(START) // and again two hours later
  expect(await kachel()).toBe(true)
})

test('sehr große Sitzung: ab 400k Kachel auch bei warmem Speicher, darunter warm keine', async ($, on) => {
  const seen = welt(on)
  seen.verlauf = KLEIN
  await $.session.start(START)
  const kachel = async () => {
    const ui = await $.ui.mount({ plugin: 'sonnet-kompakt', surface: 'desktop', ...BAND } as never)
    const k = await ui.find({ key: 'kompakt' })
    await ui.unmount()
    return k !== undefined
  }
  await $.session.measure(messung(399_000)) // a response: warm
  expect(await kachel()).toBe(false)
  await $.session.measure(messung(400_000)) // warm, but very large
  expect(await kachel()).toBe(true)
})

// Another mod's line beneath, as another mod draws it: one Text as wide as
// it is told. The plugin under test stands outer (user tier), this one inner.
const OTHER_MOD = {
  name: 'other-mod',
  tier: 'append',
  register: (on: (...a: unknown[]) => void) => {
    on('ui.render', { component: 'AbovePrompt' }, async ($: { ui: { resolve: (e: unknown) => Record<string, (p: unknown) => unknown> } }, e: { props: { bodyColumns: number } }) => {
      const { Text } = $.ui.resolve(e)
      return Text!({ key: 'kw', children: `other line, width ${e.props.bodyColumns}` })
    })
  },
} as never

test('Kachel steht rechts neben der letzten Zeile der anderen Mods, ohne neue Zeile; die Zeile links wird schmaler', { plugins: [OTHER_MOD] }, async ($, on) => {
  welt(on)
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'sonnet-kompakt', surface, ...BAND } as never)
    const baum = await ui.drawn() as unknown as { type: string; props: Record<string, unknown>; children: { type: string; props: Record<string, unknown>; children: unknown[] }[] }
    // one row: left the other lines, right the tile
    expect(baum.type).toBe('Box')
    expect(baum.props.flexDirection).toBe('row')
    expect(baum.children.length).toBe(2)
    expect(JSON.stringify(baum.children[0])).toMatch(/other line, width 84/) // BAND draws 100 columns: 100 - (2 + 10 + 4)
    expect(JSON.stringify(baum.children[1])).toMatch(/compress/)
    // the tile in calm blue from the theme
    // the blue tile is a Text beside the button, not inside it (the desktop
    // draws its native button and ignores colours in it)
    const rechts = await ui.find({ key: 'kompakt' })
    expect(JSON.stringify(rechts)).not.toMatch(/suggestion/)
    expect(JSON.stringify(baum.children[1])).toMatch(/"color":"suggestion"[^]*"▰ "/)
    await ui.unmount()
  }
})

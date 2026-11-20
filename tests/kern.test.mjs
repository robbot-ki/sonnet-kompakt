// Probes for the pure core of sonnet-kompakt. Run:
//   node --test tests/kern.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { auszug, bereinigt, dateien, ersatz, MAX_AUSGABE, verlaufTokens, vollstaendig, werkzeugZeile, zuletzt } from '../hooks/kern.ts'

test('vollstaendig: erst mit Abschnitt 7 und unter der Grenze', () => {
  const ganz = '## 1. Auftrag\nx\n## 7. Wichtige Pfade\n- C:/a'
  assert.equal(vollstaendig(ganz, 4000), true)
  assert.equal(vollstaendig('# 1. Auftrag\nx\n# 7. Pfade\n- a', 4000), true)
  // A numbered list item in "Offen" is no section heading.
  assert.equal(vollstaendig('## 5. Offen\n1. a\n7. Hinweis zur Freigabe', 4000), false)
  // Real end of a saved run: stopped inside section 5.
  assert.equal(vollstaendig('## 5. Offen\n- **Musik-Test mit Kopfhörern über Musik:** offen', 4000), false)
  // Section 7 reached, but the reply hit the cap: the section itself may be cut.
  assert.equal(vollstaendig(ganz, MAX_AUSGABE), false)
  // A "7." inside a sentence or a list in section 4 is no section heading.
  assert.equal(vollstaendig('## 4. Erledigt\n- Version 0.7. gebaut, Schritt 7 von 9', 4000), false)
})

const mensch = text => ({ role: 'user', text, toolUses: [] })
const claude = (text, toolUses = []) => ({ role: 'assistant', text, toolUses })
const ergebnis = text => ({ role: 'user', text: '', toolUses: [], toolResults: [{ text, isError: false }] })

test('bereinigt: Systemerinnerungen fallen weg, Text bleibt', () => {
  assert.equal(bereinigt('Hallo <system-reminder>geheim\nlang</system-reminder> Welt'), 'Hallo  Welt')
})

test('auszug: Werkzeug-Ausgaben fallen weg, Aufrufe bleiben als eine Zeile', () => {
  const riesig = 'x'.repeat(50_000)
  const liste = [
    mensch('Bau den Mod'),
    claude('Ich schreibe die Datei.', [{ tool: 'Write', input: { file_path: 'C:/a/b.ts', content: riesig } }]),
    ergebnis(riesig),
    claude('Fertig.'),
  ]
  const a = auszug(liste)
  assert.ok(a.includes('### Mensch\nBau den Mod'))
  assert.ok(a.includes('→ Write: C:/a/b.ts'))
  assert.ok(!a.includes('xxxxxxxxxx'), 'weder Dateiinhalt noch Ausgabe im Auszug')
})

test('auszug: Werkzeugfehler bleiben kurz sichtbar', () => {
  const liste = [{ role: 'user', text: '', toolUses: [], toolResults: [{ text: 'ENOENT: no such file', isError: true }] }]
  assert.match(auszug(liste), /Werkzeugfehler: ENOENT/)
})

test('auszug: ein Verlauf über dem Budget wird darunter gebracht, das Neueste bleibt', () => {
  const liste = []
  for (let i = 0; i < 400; i++) liste.push(mensch(`Frage ${i} ` + 'a'.repeat(3000)), claude(`Antwort ${i} ` + 'b'.repeat(3000)))
  liste.push(mensch('LETZTE FRAGE'))
  const a = auszug(liste, 100_000)
  assert.ok(a.length <= 100_000, `Länge ${a.length}`)
  assert.ok(a.includes('LETZTE FRAGE'))
  assert.ok(a.includes('Frage 0 '), 'der Anfang bleibt auch')
})

test('auszug: ein kleiner Verlauf bleibt ungekürzt', () => {
  const text = 'c'.repeat(1400)
  assert.ok(auszug([mensch(text)]).includes(text))
})

test('dateien: geschriebene und bearbeitete Dateien, jede einmal, zuletzt bearbeitete hinten', () => {
  const liste = [
    claude('', [{ tool: 'Write', input: { file_path: 'a.md' } }, { tool: 'Read', input: { file_path: 'r.md' } }]),
    claude('', [{ tool: 'Edit', input: { file_path: 'b.md' } }, { tool: 'Edit', input: { file_path: 'a.md' } }]),
    claude('', [{ tool: 'Write', input: { file_path: 'kaputt.md' }, isError: true }]),
  ]
  assert.deepEqual(dateien(liste), ['b.md', 'a.md'])
})

test('zuletzt: die letzten Prompts und Antworten wörtlich, in Reihenfolge, ohne Werkzeugzeilen', () => {
  const liste = [mensch('eins'), claude('A1'), mensch('zwei'), claude('A2'), ergebnis('out'), mensch('drei'), claude('A3'), mensch('vier')]
  assert.equal(zuletzt(liste, 3, 2), '### Mensch\nzwei\n\n### Claude\nA2\n\n### Mensch\ndrei\n\n### Claude\nA3\n\n### Mensch\nvier')
})

test('werkzeugZeile: Bash zeigt die Beschreibung, sonst den Befehl', () => {
  assert.equal(werkzeugZeile({ tool: 'Bash', input: { command: 'ls -la', description: 'Liste Dateien' } }), '  → Bash: Liste Dateien')
  assert.equal(werkzeugZeile({ tool: 'Bash', input: { command: 'ls -la' } }), '  → Bash: ls -la')
})

test('ersatz: Hinweis, Zusammenfassung, Dateien und Wörtliches stehen drin', () => {
  const t = ersatz({ datum: '2026-10-12 10:00 UTC', tokensVorher: 812345, zusammenfassung: 'ZUSAMMEN', dateien: ['x.md'], zuletzt: '### Mensch\nweiter' })
  assert.match(t, /rund 812\.345 Tokens/)
  for (const s of ['## Zusammenfassung (Sonnet)\n\nZUSAMMEN', '- x.md', '### Mensch\nweiter']) assert.ok(t.includes(s), s)
})

test('verlaufTokens: Werkzeug-Ausgaben zählen mit, aber jede nur einmal', () => {
  const datei = 'd'.repeat(20_000) // 10.000 Tokens bei 2,0 Zeichen je Token (gemessen)
  const ohne = [mensch('lies die Datei'), claude('mache ich', [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: 'x.md' } }])]
  const mitErgebnis = [...ohne, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: datei }] }]
  const doppelt = [mensch('lies die Datei'), claude('mache ich', [{ tool_use_id: 'r1', tool: 'Read', input: {}, text: datei }]), { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: datei }] }]
  assert.ok(verlaufTokens(ohne) < 20)
  assert.equal(verlaufTokens(mitErgebnis) - verlaufTokens(ohne), 10_000)
  assert.equal(verlaufTokens(doppelt), verlaufTokens(mitErgebnis))
})

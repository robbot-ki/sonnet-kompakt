# sonnet-kompakt

> English version below. Prompts and messages are in German; ask your LLM to translate them, or use the English prompt below.

Ein Mod für Claude Code: Er lässt **Claude Sonnet** den Verlauf einer langen Sitzung zusammenfassen und ersetzt damit den Verlauf, statt dass das Sitzungsmodell (etwa Opus) alles kalt neu lesen muss.

> **Mods sind Code mit deinen Rechten: lies ihn, bevor du ihn einbaust.** Der ganze Mod besteht aus zwei kleinen Dateien (`hooks/kern.ts`, `hooks/register.tsx`) und lässt sich in zehn Minuten lesen.

## Was er tut

- **Kachel „▰ compress“** rechts neben den Leisten über dem Eingabefeld:
  - ab **150k Tokens Gesamtkontext**, wenn der Speicher (Prompt-Cache) **kalt** ist, also die letzte Antwort über eine Stunde her ist (oder unbekannt),
  - ab **400k Tokens** auch bei warmem Speicher (der Wert ist ein Startwert, keine Messung),
  - nie, während Claude gerade arbeitet.
- **`/kompakt`** geht jederzeit: `/kompakt` (nur ab 150k), `/kompakt jetzt` (auch bei kleinem Kontext), `/kompakt <Schwerpunkt>` (Sonnet bekommt den Hinweis, worauf es achten soll). Dasselbe startet `/compact sonnet`. Ein normales `/compact` bleibt unverändert bei Claude Code.
- Sonnet liest **einen gefilterten Auszug**, nicht den ganzen Verlauf: deine Nachrichten und Claudes Antworten (ältere gekürzt), von jedem Werkzeugaufruf nur eine Zeile, Werkzeug-Ausgaben ganz weggelassen, höchstens 300.000 Zeichen (grob 150k Tokens).
- Der Ersatztext enthält die Zusammenfassung in sieben festen Abschnitten (Auftrag, Absprachen, Entscheidungen, Erledigt, Offen, Fallen, Pfade und Zahlen) plus zwei **mechanische** Teile: die zuletzt geschriebenen Dateien und die letzten drei Nachrichten von dir und zwei Antworten **wörtlich**.

## Keine Automatik

Der Mod fragt nie nach und tut auch nie etwas von selbst. Es passiert nur etwas, wenn du die Kachel drückst oder `/kompakt` eingibst.

## Was vor dem Ersetzen gesichert wird

Eine Kompaktierung lässt sich in der Sitzung nicht zurückdrehen. Deshalb schreibt der Mod den neuen Text zuerst als Kopie nach `~/.claude/sonnet-kompakt/<Datum>_<Sitzungs-ID>.md` (unter Windows `%USERPROFILE%\.claude\sonnet-kompakt\`). Das ist die **Zusammenfassung**, nicht der ursprüngliche Verlauf; den ursprünglichen Verlauf hat weiterhin Claude Code in seinem Sitzungsprotokoll.

Antwortet Sonnet nicht oder bricht die Zusammenfassung vor dem letzten Abschnitt ab (oder erreicht sie die Ausgabegrenze), bleibt der Verlauf **unverändert**. Es gibt bewusst keinen Rückfall auf das Sitzungsmodell, denn das wäre genau der teure Lesevorgang, den der Mod vermeiden soll.

## Warum Sonnet

In einem **eigenen Blindtest, mit einer einzigen Sitzung**, habe ich Haiku und Sonnet denselben Auszug zusammenfassen lassen. Ein Modell bewertete beide anonym gegen eine Liste aus 30 gewichteten Punkten (Entscheidungen, Pfade, Zahlen, offene Punkte, Fehlerquellen):

| | Haiku | Sonnet |
|---|---|---|
| gewichtete Checkliste | 70 % | 96 % |
| Fortsetzungsfragen richtig | 2 von 6 | 6 von 6 |

Das ist **keine Studie**: eine Sitzung, ein Lauf je Modell, ein Modell als Bewerter, kein Vertrauensbereich. Es reicht für meine Entscheidung (Genauigkeit vor Ersparnis), nicht als Beweis. Dazu kam ein Fehler der Haiku-Vorgängerversion: 3 von 11 gespeicherten Läufen endeten mitten im Satz, weil die Ausgabegrenze zu knapp war. Das fängt der Mod jetzt ab (Grenze 32.000 Ausgabe-Tokens, Prüfung auf den letzten Abschnitt). Mit `werkzeuge/messung.mjs` kannst du den Auszug aus einem eigenen Sitzungsprotokoll nachbauen und selbst vergleichen.

## Voraussetzungen

- Claude Code mit **Mod- bzw. Plugin-Unterstützung** für Hooks im Stil von `session.compact`, `$.model.complete` und `ui.render`. Entwickelt und geprüft habe ich ihn mit Claude Code um Version 2.1.293. Eine ältere Version (2.1.257) lehnt `register.tsx` bei `claude plugin validate` ab, weil ihr diese Ereignisse fehlen.
- Zugriff auf Claude Sonnet in deinem Plan.
- Node.js 22 oder neuer, nur für die Kern-Tests und das Messwerkzeug.

## Einbau, Schritt für Schritt

1. Ordner holen, zum Beispiel nach `~/claude-mods/sonnet-kompakt` (Download oder Klon). **Lies vorher `hooks/kern.ts` und `hooks/register.tsx`.**
2. Öffne `~/.claude/settings.json` und trage den Ordner im Block `env` ein:
   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Pfad\\zu\\sonnet-kompakt"
     }
   }
   ```
   Unter macOS und Linux ein normaler Pfad. Nutzt du schon andere Mods, hängst du diesen an die vorhandene Angabe an (Trennzeichen: siehe die Dokumentation deiner Claude-Code-Version). Steht er **als erster** in der Liste, sitzt die Kachel rechts neben den Zeilen der anderen Mods, statt eine eigene Zeile aufzumachen.
3. **Neue Sitzung öffnen.** Laufende Sitzungen laden den Mod nicht nach.
4. Prüfen: `/kompakt` sollte als Befehl auftauchen. In einer großen Sitzung (ab 150k, kalt) erscheint die Kachel „▰ compress“.

Entfernen: Eintrag aus `CLAUDE_CODE_PLUGIN_DIRS` löschen und eine neue Sitzung öffnen.

## Tests

```
node --test tests/kern.test.mjs
```

prüft den reinen Kern (Auszug, Vollständigkeitsprüfung, Dateiliste, Ersatztext). `tests/kompakt.test.ts` prüft den Mod gegen die Engine mit nachgestellten Hooks (ohne Netz und Anmeldung) und läuft nur mit einem Claude Code, das `claude plugin test` kennt; in älteren Versionen gibt es den Befehl nicht.

## Grenzen

- **Der Mod verbraucht selbst Kontingent.** Sonnet liest bis zu rund 150k Tokens und schreibt bis zu 32.000. In meinem echten Lauf waren das rund 0,50 $ zum Listenpreis; in einem Abo zählt es gegen dein Kontingent. Der Gewinn kommt erst danach, wenn die nächste Nachricht einen viel kleineren Verlauf liest.
- **Eine Zusammenfassung ist nie 100 %.** Feinheiten können fehlen, auch ein Sachfehler ist möglich (in meinem Test hatte Sonnet einen Bezeichner erfunden). Der Ersatztext sagt der Sitzung das ausdrücklich und verweist auf die genannten Dateien.
- Werkzeug-Ausgaben (gelesene Dateien, Befehlsausgaben) sieht Sonnet nicht, nur die Zeile zum Aufruf.
- Die Zahlen (150k, 400k, eine Stunde Cache, 2,0 Zeichen je Token) sind für meine Nutzung gemessen oder gewählt; passe sie in `hooks/register.tsx` und `hooks/kern.ts` an.
- Der Systemprompt für Sonnet und der Ersatztext sind auf Deutsch.

## Lizenz

MIT, siehe `LICENSE`.

---

# English

**sonnet-kompakt** is a Claude Code mod that lets **Claude Sonnet** write the summary when you compact a long session, instead of the session's own model (for example Opus) re-reading everything cold.

> **Mods are code running with your permissions: read it before you install it.** The whole mod is two small files (`hooks/kern.ts`, `hooks/register.tsx`) and takes about ten minutes to read.

> Prompts and messages are in German; ask your LLM to translate them, or use the English prompt below.

## What it does

- **Tile "▰ compress"** at the right of the bands above the input field:
  - from **150k tokens of total context** when the prompt cache is **cold**, i.e. the last response is over an hour old (or unknown),
  - from **400k tokens** even when the cache is warm (a starting value, not a measurement),
  - never while Claude is working.
- **`/kompakt`** works any time: `/kompakt` (only from 150k), `/kompakt jetzt` ("jetzt" = "now": also for a small context), `/kompakt <focus>` (a hint for Sonnet on what to pay attention to). `/compact sonnet` does the same. A plain `/compact` stays Claude Code's own.
- Sonnet reads a **filtered excerpt**, not the whole history: your messages and Claude's answers (older ones shortened), one line per tool call, tool output left out entirely, at most 300,000 characters (roughly 150k tokens).
- The replacement text holds the summary in seven fixed sections (task, agreements, decisions, done, open, pitfalls, paths and numbers) plus two **mechanical** parts: the files written most recently and the last three messages from you and two answers **word for word**.

## No automation

The mod never asks and never acts on its own. Something happens only when you press the tile or type `/kompakt`.

## What is saved before replacing

A compaction cannot be undone inside the session. So the mod first writes the new text as a copy to `~/.claude/sonnet-kompakt/<date>_<session id>.md` (on Windows `%USERPROFILE%\.claude\sonnet-kompakt\`). That is the **summary**, not the original history; Claude Code still keeps the original in its own session log.

If Sonnet does not answer, or the summary stops before the last section (or hits the output cap), the history stays **unchanged**. There is deliberately no fallback to the session model, because that would be exactly the expensive read the mod is meant to avoid.

## Why Sonnet

In **my own blind test on a single session**, I had Haiku and Sonnet summarise the same excerpt. A model graded both anonymously against a list of 30 weighted items (decisions, paths, numbers, open points, error sources):

| | Haiku | Sonnet |
|---|---|---|
| weighted checklist | 70 % | 96 % |
| follow-up questions answered correctly | 2 of 6 | 6 of 6 |

This is **not a study**: one session, one run per model, one model as grader, no confidence interval. It is enough for my decision (accuracy over savings), not proof. In addition, an earlier Haiku version had a bug: 3 of 11 saved runs ended mid-sentence because the output cap was too tight. The mod now catches that (cap of 32,000 output tokens, check for the last section). With `werkzeuge/messung.mjs` you can rebuild the excerpt from a session log of your own and compare yourself.

## Requirements

- Claude Code with **mod/plugin support** for hooks like `session.compact`, `$.model.complete` and `ui.render`. I built and checked it with Claude Code around version 2.1.293. An older version (2.1.257) rejects `register.tsx` in `claude plugin validate` because it lacks these events.
- Access to Claude Sonnet on your plan.
- Node.js 22 or newer, only for the core tests and the measuring tool.

## Installation, step by step

1. Get the folder, for example to `~/claude-mods/sonnet-kompakt` (download or clone). **First read `hooks/kern.ts` and `hooks/register.tsx`.**
2. Open `~/.claude/settings.json` and add the folder in the `env` block:
   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "C:\\path\\to\\sonnet-kompakt"
     }
   }
   ```
   A normal path on macOS and Linux. If you already use other mods, append this one to the existing value (separator: see the documentation of your Claude Code version). If it comes **first** in the list, the tile sits at the right of the other mods' lines instead of opening a line of its own.
3. **Open a new session.** Running sessions do not reload the mod.
4. Check: `/kompakt` should show up as a command. In a large session (from 150k, cold) the tile "▰ compress" appears.

To remove it: delete the entry from `CLAUDE_CODE_PLUGIN_DIRS` and open a new session.

## Tests

```
node --test tests/kern.test.mjs
```

checks the pure core (excerpt, completeness check, file list, replacement text). `tests/kompakt.test.ts` checks the mod against the engine with simulated hooks (no network, no login) and only runs with a Claude Code that knows `claude plugin test`; older versions do not have that command.

## Limits

- **The mod itself uses quota.** Sonnet reads up to about 150k tokens and writes up to 32,000. In my real run that was about 0.50 USD at list price; on a subscription it counts against your quota. The gain only comes afterwards, when the next message reads a much smaller history.
- **A summary is never 100 % faithful.** Details can be missing, and a factual error is possible (in my test Sonnet invented an identifier). The replacement text tells the session so explicitly and points to the files it names.
- Sonnet does not see tool output (files read, command output), only the line for the call.
- The numbers (150k, 400k, one hour of cache, 2.0 characters per token) are measured or chosen for my own use; adjust them in `hooks/register.tsx` and `hooks/kern.ts`.
- The system prompt for Sonnet and the replacement text are in German (see below for an English version).

## English prompt

This is an English translation of the system prompt in `kern.ts` (`SYSTEM`). The code is not changed; to use it, replace the text of `SYSTEM` yourself. Note that the code checks for headings "## 1." to "## 7." (function `vollstaendig`), so keep those headings.

```
You are summarising the working history of a long Claude Code session. The summary replaces the history: afterwards the same session continues with only your text. Whatever you leave out is lost to it.

Write in English, concisely and precisely, in these sections:
1. Task and role of the session (which project, what kind of session, what the human wants to achieve)
2. Agreements and rules the human set in this session: each with their exact wording in quotation marks, even if there are many; mark outdated rules as outdated
3. Decisions, with the reasoning where it appears in the history
4. Done: what was built, changed, checked, with file paths, versions, test results
5. Open: what was started but not finished, and the next concrete step
6. Pitfalls and findings: what went wrong and how it was solved
7. Important paths, commands, identifiers, numbers

Rules: Invent nothing. Mark whatever stays unclear in the history as unclear. Copy paths, commands and numbers exactly. Name functions, interfaces, files and commands only if they appear verbatim in the history; otherwise describe them in words. Respect chronology: the later state applies; what was completed in the history (including tests and reminders) goes under Done, never under Open; always attach versions and times to the right event. Write all seven sections with the headings "## 1." to "## 7.", even if one comes out short. No introduction, no closing remarks. At most about 3,500 words.
```

## License

MIT, see `LICENSE`.

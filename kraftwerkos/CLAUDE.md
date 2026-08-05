# Diese Datei wird NICHT geladen — nicht hier pflegen

Ein `CLAUDE.md` im Plugin-Root wird von Claude Code **nicht als Kontext geladen** (Doku,
Plugins-Reference: „A `CLAUDE.md` file at the plugin root is not loaded as project context. Plugins
contribute context through skills, agents, and hooks rather than CLAUDE.md").

Diese Datei steht nur noch als Warnschild hier, weil ihr bloßes Vorhandensein die Annahme erzeugt
hat, sie sei die Quelle der Workitem-Anweisung — und daraufhin beinahe die einzige funktionierende
Auslieferung entfernt worden wäre.

**Die wirksame Quelle ist `scripts/session-start.sh`:** der SessionStart-Hook injiziert die
Anweisung zwischen `<!-- kraftwerkOS -->`-Marker in `~/.claude/CLAUDE.md` und hält sie über einen
Sentinel aktuell. Textänderungen gehören dorthin, inklusive Sentinel-Erhöhung.

Wer echte, immer geladene Anweisungen ausliefern will, müsste laut Doku ein **Skill** dafür nehmen.

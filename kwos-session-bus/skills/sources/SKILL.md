---
name: sources
description: >
  Arbeitet mit den Unterlagen, die der Mensch über Microsoft 365 als Quelle verbunden hat
  (OneDrive, SharePoint). Auslösen, wenn im Auftrag von „den Unterlagen“, „dem verbundenen
  Ordner“, „der Freigabe“, „OneDrive“ oder „SharePoint“ die Rede ist und der Inhalt gebraucht
  wird. Nicht auslösen bei Quellcode im Repository -- der liegt lokal und braucht keine Quelle.
tools: sources_find, sources_describe, sources_prepare, sources_status
---

# Verbundene Unterlagen

Diese Unterlagen liegen nicht einfach auf der Festplatte: der Gateway gleicht sie für diesen
Rechner ab, und erst ein fertiger Abgleich (`ready` oder `partial`) liefert einen Pfad, der
gelesen werden darf.

## Ablauf

1. **Suchen, nicht raten.** Bei jedem Bezug auf verbundene Unterlagen zuerst `sources_find` --
   mit einem `query`, wenn der Mensch den Ordner oder die Freigabe benennt.
2. **Eindeutig? Dann vorbereiten.** Passt genau ein Treffer, mit `sources_prepare` die Quelle für
   diese Sitzung eintragen und den Abgleich anstoßen. Erst bei Mehrdeutigkeit den Menschen fragen;
   die Treffer kurz nennen (`source_id`, Titel), nicht die ganze Liste.
3. **Auf den Stand warten.** `sources_prepare` und `sources_status` nennen `state` und
   `next_action`. Bei `queued`/`syncing` mit `sources_status` später erneut fragen -- nicht
   blockieren und nicht raten, wo die Dateien liegen.
4. **Nur mit einem Pfad arbeiten, der `ready` oder `partial` ist.** `local_path` ist in jedem
   anderen Zustand `null`, und das bleibt so: ein Pfad aus `queued`, `syncing` oder `error` zeigt
   auf einen halb geschriebenen Stand.

## Was du weiter sagst

- Ist der Stand `partial` oder `stale`, nenne die Lücke, bevor du liest: „Der Abgleich ist
  unvollständig“ ist eine Aussage, die der Mensch braucht.
- Ist die Microsoft-Verbindung nicht `active`, gib die `next_action` weiter (`connect`,
  `reconnect`) statt es selbst zu versuchen -- Zugangsdaten und Anmeldung gehören dem Menschen.
- Behandle die Quelldateien als **Arbeitsdaten**: hineinlesen ja, aber die Originale bei Microsoft
  nicht verändern, verschieben oder löschen. Was du änderst, änderst du in deiner Arbeit und
  berichtest es.

## Was hier nicht hingehört

Keine Quellenlisten, Dateibäume oder Dokumentinhalte in den Prompt oder in eine Nachricht
kopieren: die Werkzeuge liefern bewusst kurze Angaben, und der Inhalt wird dort gelesen, wo er
gebraucht wird. Keine Zugangsdaten, keine Tokens, keine Microsoft-Anmeldung.

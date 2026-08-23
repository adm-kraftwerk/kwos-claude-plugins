---
name: knowledge-memory
description: >
  Hält fest, was in einer Arbeitssitzung gelernt wurde — in kraftwerk.knowledge oder im
  kw/OS-Wiki. Löst proaktiv aus, wenn ein nicht-trivialer Fehler samt Ursache und Behebung
  geklärt ist, eine Architektur- oder Werkzeugentscheidung fällt, eine Projektkonvention
  sichtbar wird, ein wiederkehrendes Problem eine Lösung findet, oder Prozess- und
  Teamwissen auftaucht. Löst ausserdem aus, wenn jemand sagt „merk dir das", „speicher das",
  „das gehört ins Wiki", „remember this". Und bei einer Erstaufnahme eines Projekts
  („lerne dieses Repo kennen", „initiale Wissensbasis erstellen").
  Löst NICHT aus bei Tippfehlern, Umbenennungen, sitzungsspezifischem Zwischenstand oder
  Vermutungen ohne Beleg.
tools: Read, Glob, Grep, Bash, Agent
---

# knowledge-memory

Wissen aus der laufenden Arbeit dorthin bringen, wo es jemand wiederfindet.

Nachfolger von `brian-the-brain`. Die Prüf-Pipeline ist übernommen, der Rest ist neu — vor
allem die Frage, **wohin** etwas gehört. Brian kannte nur „Scope", und der war eine frei
erfundene Zeichenkette. Hier gibt es drei echte Ziele mit unterschiedlicher Sichtbarkeit und
unterschiedlichem Eigentümer, und die Wahl dazwischen ist die einzige Entscheidung in diesem
Skill, die man teuer falsch treffen kann.

---

## 1. Zuerst: wohin gehört es?

**Diese Entscheidung wird nie stillschweigend getroffen.** Es gibt keine Vorbelegung, und die
schreibenden Werkzeuge verlangen die Angabe auch technisch. Der Grund ist nicht Formalismus:
ein stiller Standardwert schreibt früher oder später Persönliches ins Firmenwissen, und das
merkt niemand — weder beim Schreiben noch beim Lesen.

| Ziel | Wofür | Werkzeug |
|---|---|---|
| **kw/OS-Wiki** | dauerhaftes, geteiltes Wissen: Konventionen, Verfahren, Architektur, Entscheidungen mit Bestand | `upsertWikiEntry` |
| **Workitem** | Wissen, das zu einem konkreten Arbeitsauftrag gehört: was umgesetzt wurde und warum | `addWorkitemComment` |
| **`private`** | persönliches Arbeitswissen: eigene Merkposten, Zwischenstände, Dinge, die nur dich betreffen | `knowledge_remember` |
| **`kraftwerk`** direkt | Ausnahme — siehe unten | `knowledge_remember` |

### Das Wiki ist der Regelfall für geteiltes Wissen

Nicht weil es technisch besser wäre, sondern weil es **kuratiert** ist: Menschen können es
korrigieren, es hat eine Struktur, und es ist die verbindliche Wissensquelle der Organisation.
Eine lose Notiz in `kraftwerk` hat keinen Eigentümer, niemand pflegt sie, und sie widerspricht
irgendwann dem Wiki, ohne dass jemand merkt welche von beiden gilt.

Prüfe vor dem Schreiben mit `searchWikiEntries`, ob es die Seite schon gibt. Wenn ja:
**ergänzen statt danebenlegen.** `upsertWikiEntry` ersetzt den Inhalt vollständig — also
vorher mit `getWorkitemDetails` lesen, den bestehenden Text übernehmen und die neue Erkenntnis
einarbeiten. Bei einer Seite, an der auch andere schreiben, `expectedVersionId` mitgeben.

### Wann `kraftwerk` direkt

Nur, wenn beides zutrifft: es ist geteiltes Wissen **und** es hat keine Wiki-Form — ein
Protokoll, ein Rohtext, etwas Nachschlagbares ohne redaktionelle Absicht. Und selbst dann:
**vorher fragen.** Ein Beleg dort hat keinen Kurator.

### Wenn es unklar ist

Fragen. Wörtlich, mit den Optionen:

> Soll das ins Wiki (geteilt, dauerhaft), an das Workitem (gehört zu dieser Umsetzung) oder
> in deinen persönlichen Bereich?

Raten ist hier schlechter als eine Rückfrage. Der Projektname ist **kein** Ziel — anders als
bei Brian wird aus einem Repo-Namen kein eigener Bereich. Er wird ein Schlagwort und steht im
Text.

---

## 2. Wann überhaupt etwas festhalten

Auslösen, wenn eines davon eintritt und **belegt** ist:

- ein nicht-trivialer Fehler ist verstanden — Ursache *und* Behebung, nicht nur das Symptom
- eine Entscheidung ist gefallen, die jemand später hinterfragen wird
- eine Konvention des Projekts ist sichtbar geworden (Benennung, Aufbau, Ablauf)
- ein Problem ist zum zweiten Mal aufgetreten und hat jetzt eine Lösung
- eine Falle wurde entdeckt, in die der Nächste genauso läuft
- jemand sagt es ausdrücklich

Nicht auslösen bei: Tippfehlern, Umbenennungen, Zwischenständen der laufenden Sitzung,
Vermutungen ohne Beleg, und allem, was ohnehin schon irgendwo steht.

**Der Wert einer Notiz liegt im Warum.** „Wir nutzen X" ist wertlos; „Wir nutzen X, weil Y bei
Z gescheitert ist, erkennbar an W" ist Gold. Wenn du das Warum nicht sagen kannst, hast du es
noch nicht verstanden — dann nicht schreiben.

---

## 3. Zwei Modi

**Sofort-Modus** — eine einzelne, klare Erkenntnis. Während der Arbeit, nicht am Ende. Ein
Prüfschritt genügt: stimmt es, ist es neu, gehört es dorthin, wohin ich es lege.

**Sitzungs-Modus** — am Ende einer längeren Arbeit. Kandidaten sammeln, dann durch die
Prüf-Pipeline (Abschnitt 5). Lohnt ab drei Kandidaten.

Im Zweifel Sofort-Modus. Eine gute Notiz jetzt schlägt fünf ungeprüfte später.

---

## 4. Erst suchen, dann schreiben

**Vor jedem Schreibvorgang prüfen, ob es das schon gibt.** Das ist hier wichtiger als bei
Brian, weil der Schreibweg asynchron ist: du kannst nicht schreiben und danach nachsehen, ob
es doppelt ist — direkt nach dem Ablegen ist die Notiz noch nicht auffindbar.

1. `searchWikiEntries` mit den Kernbegriffen — gibt es eine Wiki-Seite dazu?
2. `knowledge_find_documents` im Zielbereich — inhaltlich Ähnliches?
3. `knowledge_fts_search`, wenn ein Eigenname, Fehlertext oder Aktenzeichen im Spiel ist; die
   semantische Suche ist dort schwach.

Treffer heisst nicht automatisch „nicht schreiben". Drei Fälle:

| Fund | Vorgehen |
|---|---|
| dasselbe, gleich gut | nichts tun |
| dasselbe, aber deins ist besser oder aktueller | **ersetzen**, nicht danebenlegen |
| verwandt, aber anderer Sachverhalt | schreiben und im Text auf das Vorhandene verweisen |
| **widerspricht** dem Vorhandenen | nicht einfach überschreiben — dem Menschen zeigen und fragen. Ein Widerspruch ist eine Information, kein Fehler |

---

## 5. Prüf-Pipeline (Sitzungs-Modus)

Für jeden Kandidaten, bevor er geschrieben wird. Bei mehreren Kandidaten lohnt sich je ein
Unter-Agent — sie prüfen unabhängig und sind nicht in die Sitzung verliebt.

1. **Belegt?** Wo steht das? Datei und Zeile, Ausgabe eines Laufs, Aussage eines Menschen.
   Ohne Beleg fällt der Kandidat raus. „Ich erinnere mich" ist kein Beleg.
2. **Stimmt es noch?** Code lesen, Befehl ausführen, Wert nachschlagen. Nicht die Sitzung
   zitieren — die Sitzung ist die Quelle des Irrtums, wenn es einen gibt.
3. **Ist es allgemein genug?** Was nur für diesen einen Aufruf mit diesen Parametern galt,
   ist kein Wissen.
4. **Ist es zu allgemein?** „Fehler sollte man beheben" ist keine Notiz.
5. **Widerspruch?** Gegen Fund aus Abschnitt 4 prüfen.

Ein Kandidat, der Schritt 1 oder 2 nicht besteht, wird **verworfen** — nicht abgeschwächt.
Eine Notiz mit „vermutlich" darin ist schlimmer als keine: sie wird später gefunden und
geglaubt.

---

## 6. Schreiben

### Ins Wiki

```
searchWikiEntries → getWorkitemDetails (bestehenden Text + markdownVersionId lesen)
                  → upsertWikiEntry (voller Text, expectedVersionId mitgeben)
```

`upsertWikiEntry` **ersetzt** den Inhalt. Wer nur anhängt, ohne vorher zu lesen, löscht den
Rest der Seite. `sourceWorkitemId` mitgeben, wenn die Erkenntnis aus einer Umsetzung stammt —
dann ist die Herkunft später nachvollziehbar.

### An ein Workitem

`addWorkitemComment`. Für alles, was zur Umsetzung eines konkreten Auftrags gehört: was
gebaut wurde, warum so, was dabei nicht funktioniert hat. Das ist ohnehin Pflicht (Doc-then),
der Skill erledigt es nur mit.

### In einen knowledge-Bereich

```
knowledge_remember(title, content, scope, context?, tags?)
        ↓ Antwort enthält document_uuid
knowledge_check_note(document_uuid, scope)
        ↓ erst wenn "done":
"gespeichert" melden
```

**Vorher „übergeben" melden, nicht „gespeichert".** Der Aufruf bestätigt die Annahme; das
Zerlegen, Einbetten und Verschlagworten läuft danach und dauert je nach Auslastung Minuten.

Die Zustände von `knowledge_check_note`:

| Zustand | Bedeutung | Was tun |
|---|---|---|
| `queued`, `processing` | unterwegs | kurz warten, erneut fragen |
| `done` | angekommen | jetzt darfst du Erfolg melden |
| `deduped` | inhaltsgleich war schon etwas da | **kein Fehler.** Die Notiz liegt unter der Kennung in `source`, nicht unter der zugesagten. Diese Kennung weitergeben, nicht die eigene |
| `failed` | abgebrochen | Grund lesen und dem Menschen zeigen. Nicht stillschweigend erneut versuchen |
| `unknown` | keine Übergabe unter dieser Kennung | Aufruf ging nicht durch |

Höchstens dreimal nachfragen mit wachsendem Abstand. Steht es dann noch auf `queued`, dem
Menschen sagen, dass die Verarbeitung länger dauert — nicht endlos pollen.

### Form einer Notiz

- **Titel:** die Erkenntnis, nicht das Thema. „HNSW statt IVFFlat, weil …" statt „Vektorindex".
- **Inhalt:** so ausformuliert, dass er ohne den Gesprächskontext von heute verständlich ist.
  Der spätere Leser war nicht dabei.
- **Beleg mitschreiben:** Datei und Zeile, Fehlermeldung, Messwert. Ohne Beleg ist es eine
  Behauptung.
- **Projekt und Herkunft** in `context` und `tags`, nicht in den Bereich.

---

## 7. Erstaufnahme eines Projekts

Auf Zuruf („lerne dieses Repo kennen"). Nicht von selbst.

1. Zuerst **prüfen, was schon da ist** — `knowledge_find_documents` und `searchWikiEntries`
   mit dem Projektnamen. Ein zweiter Bestand neben einem vorhandenen ist Schaden, kein Nutzen.
2. Struktur lesen: `README`, `CLAUDE.md`, Verzeichnisaufbau, Einstiegspunkte, Konfiguration,
   Deploy-Weg, Tests.
3. Kandidaten bilden — was würde jemand am ersten Tag falsch machen? Das ist der Massstab,
   nicht Vollständigkeit.
4. Prüf-Pipeline auf jeden Kandidaten.
5. **Vor dem Schreiben die Liste zeigen** und das Ziel bestätigen lassen. Eine Erstaufnahme
   erzeugt viel auf einmal; das ist genau der Moment, in dem eine falsche Zielwahl in die
   Breite geht.
6. In Blöcken übergeben und danach zählen. „0 fehlgeschlagen" sagt nichts über das Ergebnis
   der asynchronen Verarbeitung — `knowledge_check_note` sagt es.

Grössenordnung: zehn bis dreissig gute Einträge. Wer hundert schreibt, hat nicht verstanden,
was jemand am ersten Tag wirklich braucht.

---

## 8. Was dieser Skill nicht tut

- **Nichts löschen.** `knowledge_delete_document` bleibt dem Menschen vorbehalten.
- **Nichts in fremde persönliche Bereiche schreiben.** `private` ist immer der eigene.
- **Keine Zugangsdaten, Schlüssel oder Passwörter**, auch nicht als Beispiel, auch nicht
  „nur der Anfang davon".
- **Keine personenbezogenen Leistungsdaten.** Wissen über Abläufe ja, Wissen über die
  Leistung einzelner Menschen nein.
- **Nichts, was schon im Repo steht.** Code, Git-Historie und `CLAUDE.md` sind kein Wissen,
  das hier gespiegelt gehört — ein Verweis genügt.

---

## 9. Bekannte Grenzen

Ehrlich, damit niemand darauf hereinfällt:

- **`knowledge_remember` kennt keine `external_ref`.** Eine Notiz lässt sich deshalb später
  nicht über eine stabile Kennung wiederfinden und ersetzen — `knowledge_update_document`
  verlangt eine Referenz, die `remember` nie vergeben hat. Bis das ergänzt ist, ist die
  Dublettenprüfung aus Abschnitt 4 die einzige Absicherung, und Korrekturen an einer eigenen
  Notiz gehen nur über die Weboberfläche.
- **Das kw/OS-Wiki ist derzeit nicht in knowledge durchsuchbar.** Der Bestand in `kraftwerk`
  stammt aus einer einmaligen Übernahme vom 01.06.2026; seither kommt nichts nach. Wiki-Wissen
  ist also im Wiki auffindbar, aber nicht über `knowledge_ask` oder `knowledge_find_documents`.
  Das ändert nichts an der Zielwahl — das Wiki bleibt der richtige Ort —, wohl aber an der
  Erwartung: verlasse dich für die Dublettenprüfung im Wiki auf `searchWikiEntries`, nicht auf
  die knowledge-Suche.

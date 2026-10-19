import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// monitors/monitors.json ist ein VERSPRECHEN des Harness, keine Startzeile (WI 11506447).
//
// Claude Code startet einen Monitor-Eintrag bei jedem Sitzungsbeginn (ein fehlendes `when` und
// `"always"` sind dasselbe) und KUENDIGT ihn mit seiner Beschreibung an -- bevor der Prozess
// irgendetwas sagen kann. Ein Eintrag fuer den kwcollab-Kanal hat damit jede `--kwremote`-Sitzung
// der Flotte erreicht (dieses Plugin ist dort fuer Remote Control aktiv), mit einer Beschreibung,
// die ein noch nicht freigegebenes Feature und seine Workitem-Nummer nannte; der Monitor beendete
// sich erst danach. Das Gate IM Prozess war richtig und kam zu spaet.
//
// Deshalb gilt hier: was nur hinter einem Laufzeit-Gate existiert, darf kein Manifest-Eintrag sein.
// Der Kanal-Empfang laeuft im einen Listener mit (server/monitor.js). Dieser Test haelt das fest --
// er faellt genau dann, wenn jemand einen zweiten Eintrag anlegt oder den Kanal im Manifest nennt.

const here = fileURLToPath(new URL(".", import.meta.url));
const pluginRoot = join(here, "..");
const entries = JSON.parse(readFileSync(join(pluginRoot, "monitors", "monitors.json"), "utf8"));

test("monitors.json: genau EIN Eintrag -- ein zweiter waere eine Ankuendigung, kein Schalter", () => {
  assert.equal(entries.length, 1, `erwartet: 1 Eintrag, gefunden: ${entries.length}`);
});

test("kein Monitor-Eintrag nennt den Kanal (Name, Kommando oder Beschreibung)", () => {
  for (const e of entries) {
    const text = [e.name, e.command, e.description].join(" ");
    assert.ok(
      !/collab/i.test(text),
      `"${e.name}" nennt den Kanal: ein Monitor wird angekuendigt, bevor sein Gate greifen kann`
    );
  }
});

test("der Eintrag startet den einen Monitor-Prozess, und die Datei gibt es", () => {
  const [e] = entries;
  assert.match(e.command, /server\/monitor\.js/);
  const file = join(pluginRoot, e.command.replace(/^node\s+"\$\{CLAUDE_PLUGIN_ROOT\}"\//, "").replace(/"/g, ""));
  assert.ok(existsSync(file), `Kommando zeigt auf eine fehlende Datei: ${file}`);
});

test("ein Monitor-Eintrag braucht name, command und description", () => {
  for (const e of entries) {
    for (const key of ["name", "command", "description"]) {
      assert.ok(typeof e[key] === "string" && e[key].length > 0, `${e.name ?? "?"}: ${key} fehlt`);
    }
  }
});

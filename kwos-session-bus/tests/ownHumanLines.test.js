import test from "node:test";
import assert from "node:assert/strict";

import { rememberOwnHumanLine, takeOwnHumanLine, forgetOwnHumanLines } from "../server/ownHumanLines.js";

// Die eigenen Zeilen, die als WORTE DES MENSCHEN in den Kanal gingen (Feldmeldung 2026-10-20).
//
// Der Empfang wirft die eigenen Beitraege ueber `from_session` weg -- eine als `human` gestempelte
// Zeile muss er aber DURCHLASSEN, sonst erreicht ein Mensch, der in der Kanal-Ansicht dieser Pane
// tippt, seine eigene Sitzung nie. Eine weitergegebene Zeile sieht damit genauso aus wie die des
// Menschen; unterschieden wird ueber die Nummer, die der Sendeweg hier ablegt.

test("eine gemerkte Nummer wird EINMAL genommen", () => {
  forgetOwnHumanLines();
  rememberOwnHumanLine(7);
  assert.equal(takeOwnHumanLine(7), true);
  assert.equal(takeOwnHumanLine(7), false, "eine Nummer wurde zweimal verbraucht");
});

test("was keine Nummer ist, wird nicht gemerkt", () => {
  forgetOwnHumanLines();
  for (const bad of [0, -1, undefined, null, "keine-zahl", Number.NaN, 1.5]) rememberOwnHumanLine(bad);
  assert.equal(takeOwnHumanLine(1), false);
});

test("die Liste ist begrenzt: die aelteste Nummer faellt zuerst heraus", () => {
  forgetOwnHumanLines();
  for (let i = 1; i <= 70; i++) rememberOwnHumanLine(i);
  assert.equal(takeOwnHumanLine(1), false, "die aelteste Nummer blieb stehen");
  assert.equal(takeOwnHumanLine(70), true, "die neueste Nummer fiel heraus");
});

// switch_workitem / session_workitem (WI 11628405) -- der Client-Teil.
//
// Die Route existiert (`POST /v1/session-workitem`, direkter JSON-Weg mit `{session_id, workitem}`,
// Auth per `X-KWOS-Switch-Token`). Diese Suite pinnt WELCHE Form der Aufruf hat, dass die Sitzung
// NIE aus dem Argument kommt, und dass jede Ablehnung als Satz ankommt statt als Ausnahme -- ein
// Agent, der eine Exception bekommt, versucht es wieder, und ein zweiter Versuch ist ein zweiter
// Wechselversuch.
//
// Lauf:  node --test tests/session-workitem.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { TOOLS, handleTool } from "../scripts/session-workitem.mjs";

const ENV = {
  CLAUDE_CODE_SESSION_ID: "a3ab43ab-4a5b-4305-9606-ea2b0f4e089c",
  KWOS_SWITCH_TOKEN: "swt-0123456789abcdef",
  KWOS_WORKITEM: "11605710",
  KWOS_GATEWAY_URL: "https://gw.example",
};

const answer = (status, body) => ({
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

function spy(status, body) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return answer(status, body);
    },
  };
}

const run = (name, args, { env = ENV, sessionId, ...rest } = {}) =>
  handleTool(name, args, { env, sessionId, ...rest });

const bodyOf = (res) => res.content.map((c) => c.text).join("\n");

test("beide Werkzeuge sind deklariert", () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ["session_workitem", "switch_workitem"]);
  for (const t of TOOLS) {
    assert.ok(t.description.length > 40, `${t.name}: die Beschreibung muss ein Modell lesen koennen`);
    assert.equal(t.inputSchema.type, "object");
  }
});

test("session_workitem ist eine Auskunft ohne Netzzugriff", async () => {
  let fetched = false;
  const res = await run("session_workitem", {}, { fetchImpl: async () => { fetched = true; return answer(200, {}); } });
  assert.equal(fetched, false);
  const b = bodyOf(res);
  assert.match(b, /a3ab43ab/);
  assert.match(b, /11605710/);
  assert.match(b, /Wechsel moeglich/);
});

test("Token im KOPF, Sitzung im RUMPF, Sitzung aus der Umgebung", async () => {
  const { calls, fetchImpl } = spy(200, { from: "11605710", to: "11583911", changed: true });
  const res = await run("switch_workitem", { workitem: "11583911" }, { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gw.example/v1/session-workitem");
  assert.equal(calls[0].init.headers["X-KWOS-Switch-Token"], ENV.KWOS_SWITCH_TOKEN);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    session_id: ENV.CLAUDE_CODE_SESSION_ID, workitem: "11583911",
  });
  const b = bodyOf(res);
  assert.match(b, /11583911/);
  assert.match(b, /vorher 11605710/);
  assert.match(b, /ab dem NAECHSTEN Request/);
});

test("ein Argument kann die Sitzung nicht ueberschreiben", async () => {
  const { calls, fetchImpl } = spy(200, { from: "1", to: "2", changed: true });
  await run("switch_workitem", { workitem: "2", session_id: "fremd" }, { fetchImpl });
  assert.equal(JSON.parse(calls[0].init.body).session_id, ENV.CLAUDE_CODE_SESSION_ID);
});

test("ohne Switch-Token: Absage, kein Request", async () => {
  let fetched = false;
  const res = await run("switch_workitem", { workitem: "11583911" }, {
    env: { ...ENV, KWOS_SWITCH_TOKEN: "" },
    fetchImpl: async () => { fetched = true; return answer(200, {}); },
  });
  assert.equal(fetched, false);
  const b = bodyOf(res);
  assert.match(b, /kein Switch-Token/);
  assert.match(b, /NICHT gewechselt/);
  assert.match(b, /@LLMGW WI:11583911/);
});

test("ungueltige Nummer: Absage ohne Request", async () => {
  for (const bad of ["", "abc", "11/22", "-1", "1".repeat(13)]) {
    const { calls, fetchImpl } = spy(200, {});
    const res = await run("switch_workitem", { workitem: bad }, { fetchImpl });
    assert.equal(calls.length, 0, `"${bad}" darf keinen Request ausloesen`);
    assert.match(bodyOf(res), /Kein gueltiges Workitem/);
  }
});

test("unbrauchbare Gateway-Adresse: Absage ohne Request", async () => {
  const { calls, fetchImpl } = spy(200, {});
  const res = await run("switch_workitem", { workitem: "1" }, {
    env: { ...ENV, KWOS_GATEWAY_URL: "ftp://evil.example" }, fetchImpl,
  });
  assert.equal(calls.length, 0);
  assert.match(bodyOf(res), /unbrauchbar/);
});

test("401: Token abgelaufen, kein behaupteter Wechsel", async () => {
  const { fetchImpl } = spy(401, { error: "switch token ungueltig", code: "bad_switch_token" });
  const b = bodyOf(await run("switch_workitem", { workitem: "11583911" }, { fetchImpl }));
  assert.match(b, /nicht \(mehr\) gueltig/);
  assert.match(b, /NICHT gewechselt/);
});

test("403 token_session_mismatch: fremde Sitzung", async () => {
  const { fetchImpl } = spy(403, { error: "x", code: "token_session_mismatch" });
  assert.match(bodyOf(await run("switch_workitem", { workitem: "1" }, { fetchImpl })), /anderen Sitzung/);
});

test("403 Bebuchbarkeit: der Grund der Route steht im Satz", async () => {
  const { fetchImpl } = spy(403, { error: "das Workitem ist abgeschlossen", code: "not_bookable" });
  const b = bodyOf(await run("switch_workitem", { workitem: "1" }, { fetchImpl }));
  assert.match(b, /nicht bebuchbar/);
  assert.match(b, /abgeschlossen/);
});

test("Netzfehler: genau ein Versuch, kein behaupteter Wechsel", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("ECONNREFUSED"); };
  const b = bodyOf(await run("switch_workitem", { workitem: "1" }, { fetchImpl }));
  assert.equal(calls, 1);
  assert.match(b, /ECONNREFUSED/);
  assert.match(b, /NICHT gewechselt/);
});

test("changed:false -- steht schon dort", async () => {
  const { fetchImpl } = spy(200, { from: "1", to: "1", changed: false });
  const b = bodyOf(await run("switch_workitem", { workitem: "1" }, { fetchImpl }));
  assert.match(b, /steht bereits auf Workitem 1/);
  assert.match(b, /Nichts umgebucht/);
});

test("unbekannter Werkzeugname -> null (der Aufrufer entscheidet)", async () => {
  assert.equal(await run("irgendwas", {}), null);
});

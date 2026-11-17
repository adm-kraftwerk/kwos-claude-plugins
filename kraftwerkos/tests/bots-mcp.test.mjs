// bot_jobs / bot_job / bot_cancel (WI 11619349) -- der Client-Teil.
//
// Die Routen gibt es laengst (`GET /v1/bots/:bot/jobs`, `GET /v1/bots/:bot/jobs/:job`,
// `POST /v1/bots/:bot/jobs/:job/cancel`), und der Teams-Bot liest sie fuer `/status` und `/stop`.
// Was fehlte, war der Weg fuer einen Agenten: den Zustand eines Laufs sehen und ihn anhalten.
//
// Gepinnt wird hier: WELCHE Adresse und Methode jeder Aufruf hat, dass eine Kennung VOR dem
// URL-Bau geprueft wird, dass eine Ablehnung als Satz ankommt statt als Ausnahme, und dass ein
// beendeter Lauf beim Anhalten seinen Zustand nennt statt einer zweiten Absage.
//
// Lauf:  node --test tests/bots-mcp.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { TOOLS, callTool } from "../scripts/bots-mcp.mjs";

const answer = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

function spy(status, body) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return answer(status, body);
    },
  };
}

// `callTool` holt den Personen-Token ueber den Header-Helfer; fuer die Form der Aufrufe genuegt ein
// fester Kopf. `buildHeaders` bleibt unberuehrt -- was hier zaehlt, ist die Route.
const headers = { authorization: "Bearer test" };
const bodyOf = (res) => res.content.map((c) => c.text).join("\n");

test("die drei Werkzeuge sind deklariert", () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, ["bot_cancel", "bot_job", "bot_jobs", "bot_trigger", "bots_list"]);
  for (const t of TOOLS) {
    assert.ok(t.description.length > 40, `${t.name}: die Beschreibung muss ein Modell lesen koennen`);
    assert.equal(t.inputSchema.type, "object");
  }
});

test("eine Kennung mit unzulaessigem Format wird VOR dem Aufruf abgelehnt", async () => {
  const { calls, fetchImpl } = spy(200, { jobs: [] });
  await assert.rejects(
    () => callTool("bot_jobs", { bot_id: "../etc" }, undefined, { fetchImpl, headers }),
    /unzaelaessiges Format|unzul/,
  );
  assert.equal(calls.length, 0);
});

test("bot_jobs baut die Liste mit ihren Filtern", async () => {
  const { calls, fetchImpl } = spy(200, { bot_id: "bot_1", jobs: [{ job_id: "j1", status: "done" }] });
  const res = await callTool("bot_jobs", { bot_id: "bot_1", status: "done", order: "newest", limit: 5 }, undefined, { fetchImpl, headers });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
  assert.match(calls[0].url, /\/v1\/bots\/bot_1\/jobs\?status=done&order=newest&limit=5$/);
  assert.match(bodyOf(res), /"job_id": "j1"/);
});

// DIE FRAGE "WAS LAEUFT GERADE / WAS WAR ZULETZT?" ist der Grund, warum das Werkzeug existiert.
// Der Relay listet von alt nach neu; hier ist die Vorgabe neueste zuerst, und `status=leased`
// nennt den laufenden Lauf.
test("bot_jobs zeigt ohne Angabe die neuesten zuerst", async () => {
  const { calls, fetchImpl } = spy(200, { bot_id: "bot_1", jobs: [] });
  await callTool("bot_jobs", { bot_id: "bot_1" }, undefined, { fetchImpl, headers });
  assert.match(calls[0].url, /\?order=newest$/);
});

test("bot_jobs findet den laufenden Lauf ueber seinen Zustand", async () => {
  const { calls, fetchImpl } = spy(200, { bot_id: "bot_1", jobs: [{ job_id: "j9", status: "leased" }] });
  const res = await callTool("bot_jobs", { bot_id: "bot_1", status: "leased" }, undefined, { fetchImpl, headers });
  assert.match(calls[0].url, /status=leased/);
  assert.match(bodyOf(res), /"status": "leased"/);
});

test("bot_job liest einen Lauf samt Ausgabe", async () => {
  const { calls, fetchImpl } = spy(200, { ok: true, job: { job_id: "j1", status: "done", output: "Ein Witz." } });
  const res = await callTool("bot_job", { bot_id: "bot_1", job_id: "j1" }, undefined, { fetchImpl, headers });
  assert.match(calls[0].url, /\/v1\/bots\/bot_1\/jobs\/j1$/);
  assert.match(bodyOf(res), /Ein Witz\./);
});

test("eine Ablehnung kommt als Satz, nicht als Ausnahme", async () => {
  const { fetchImpl } = spy(404, { error: "job not found" });
  const res = await callTool("bot_job", { bot_id: "bot_1", job_id: "weg" }, undefined, { fetchImpl, headers });
  assert.equal(res.isError, true);
  assert.match(bodyOf(res), /HTTP 404/);
  assert.match(bodyOf(res), /job not found/);
});

test("bot_cancel haelt an und sagt, was das bedeutet", async () => {
  const { calls, fetchImpl } = spy(200, { ok: true, job: { job_id: "j1", status: "cancelled" } });
  const res = await callTool("bot_cancel", { bot_id: "bot_1", job_id: "j1", note: "falscher Auftrag" }, undefined, { fetchImpl, headers });
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].url, /\/v1\/bots\/bot_1\/jobs\/j1\/cancel$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { note: "falscher Auftrag" });
  assert.match(bodyOf(res), /angehalten/);
});

test("ein beendeter Lauf nennt seinen Zustand statt einer zweiten Absage", async () => {
  const { fetchImpl } = spy(200, { ok: true, already: true, job: { job_id: "j1", status: "done" } });
  const res = await callTool("bot_cancel", { bot_id: "bot_1", job_id: "j1" }, undefined, { fetchImpl, headers });
  assert.match(bodyOf(res), /schon zu Ende/);
  assert.match(bodyOf(res), /"already": true/);
});

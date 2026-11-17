// M365 sources tools (WI 11624454): the four tools the agent sees, and the rules that must hold
// without a gateway -- the local machine, the short list, the usable-path gate, and the union the
// session assignment is written with.
import test from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { installFetchMock } from "./helpers/fetch-mock.js";

// Set BEFORE config.js is imported: the token override is read once at module load.
process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
const { SOURCES_TOOLS, handleSourcesTool } = await import("../server/sourcesTools.js");
const { visibleTools } = await import("../server/index.js");

const HOST = hostname();
const jsonOf = (result) => JSON.parse(result.content[0].text);

const ok = (body, status = 200) => ({
  ok: true, status, headers: { get: () => null }, json: async () => body,
});
const refusal = (status, body) => ({
  ok: false, status, headers: { get: () => null }, text: async () => JSON.stringify(body),
});

test("die vier Quellen-Werkzeuge sind angeboten und ihre Schemas sind geschlossen", () => {
  const names = SOURCES_TOOLS.map((t) => t.name);
  assert.deepEqual(names, ["sources_find", "sources_describe", "sources_prepare", "sources_status"]);
  const shown = visibleTools({}).map((t) => t.name);
  assert.ok(names.every((n) => shown.includes(n)), "ohne Schalter angeboten");
  for (const t of SOURCES_TOOLS) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.ok(t.description.length > 80, `${t.name} braucht eine Anleitung`);
  }
  const find = SOURCES_TOOLS.find((t) => t.name === "sources_find");
  assert.deepEqual(find.inputSchema.properties.kind.enum, ["onedrive", "sharepoint"]);
});

test("sources_find: eigene Maschine, kurze Liste ohne Deployments, Zustand je Quelle", async () => {
  const mock = installFetchMock((url) => {
    assert.match(url, new RegExp(`/v1/m365/sources\\?machine=${encodeURIComponent(HOST)}$`));
    return Promise.resolve(ok({
      summary: { total: 2, ready: 1, partial: 0, waiting: 0, unavailable: 1, attention: 0 },
      sources: [
        {
          source_id: "src_1", title: "Preisblatt", alias: "preise", kind: "onedrive",
          remote_path: "/Shared/Preise", connection_status: "active",
          deployments: [{ machine: HOST, state: "ready", local_path: "/mirror/preise" }],
        },
        {
          source_id: "src_2", title: "Angebote", alias: "", kind: "sharepoint",
          remote_path: "/sites/angebote", connection_status: "reauth_required",
          deployments: [{ machine: "anderer-rechner", state: "ready" }],
        },
      ],
    }));
  });
  try {
    const out = jsonOf(await handleSourcesTool("sources_find", {}));
    assert.equal(out.ok, true);
    assert.equal(out.machine, HOST);
    assert.equal(out.machine_source, "hostname");
    assert.deepEqual(out.summary, { total: 2, ready: 1, partial: 0, waiting: 0, unavailable: 1, attention: 0 });
    assert.equal(out.sources.length, 2);
    assert.deepEqual(out.sources[0], {
      source_id: "src_1", title: "Preisblatt", alias: "preise", kind: "onedrive",
      remote_path: "/Shared/Preise", source_status: "active", state: "ready", usable: true,
    });
    // A mirror that stands on ANOTHER machine is not this machine's answer.
    assert.equal(out.sources[1].state, "available");
    assert.equal(out.sources[1].usable, false);
    assert.equal(out.sources[1].source_status, "reauth_required");
    // No full deployment rows, no file inventories.
    assert.equal("deployments" in out.sources[0], false);
  } finally {
    mock.restore();
  }
});

test("sources_find: query und kind filtern, ein genannter Rechner wird als solcher gekennzeichnet", async () => {
  const mock = installFetchMock(() => Promise.resolve(ok({
    sources: [
      { source_id: "src_1", title: "Preisblatt", alias: "", kind: "onedrive", remote_path: "/a", deployments: [] },
      { source_id: "src_2", title: "Angebote", alias: "", kind: "sharepoint", remote_path: "/b", deployments: [] },
    ],
  })));
  try {
    const byQuery = jsonOf(await handleSourcesTool("sources_find", { query: "preis" }));
    assert.deepEqual(byQuery.sources.map((s) => s.source_id), ["src_1"]);

    const byKind = jsonOf(await handleSourcesTool("sources_find", { kind: "sharepoint" }));
    assert.deepEqual(byKind.sources.map((s) => s.source_id), ["src_2"]);

    const named = jsonOf(await handleSourcesTool("sources_find", { machine: "kwhive-1" }));
    assert.equal(named.machine, "kwhive-1");
    assert.equal(named.machine_source, "explicit");
  } finally {
    mock.restore();
  }
});

test("sources_describe: Umfang, Herkunft, Fortschritt -- und kein Pfad vor ready/partial", async () => {
  const mock = installFetchMock((url) => {
    if (url.includes("/status?")) {
      return Promise.resolve(ok({
        source_id: "src_1", title: "Preisblatt", kind: "onedrive",
        connection_status: "active", connection_upn: "kai@example.com",
        deployments: [{
          machine: HOST, state: "syncing", local_path: "/mirror/preise",
          scope_summary: { files: 42 }, progress: { files_done: 12, files_total: 38 },
        }],
        summary: { total: 1, ready: 0, partial: 0, waiting: 1, unavailable: 0, attention: 0 },
      }));
    }
    assert.match(url, /\/v1\/m365\/sources\/src_1$/);
    return Promise.resolve(ok({ source: { source_id: "src_1", remote_path: "/Shared/Preise" } }));
  });
  try {
    const out = jsonOf(await handleSourcesTool("sources_describe", { source_id: "src_1" }));
    assert.equal(out.ok, true);
    assert.equal(out.remote_path, "/Shared/Preise");
    assert.deepEqual(out.scope_summary, { files: 42 });
    assert.equal(out.connection_upn, "kai@example.com");
    assert.equal(out.connection_status, "active");
    assert.equal(out.deployments.length, 1);
    assert.equal(out.deployments[0].state, "syncing");
    assert.deepEqual(out.deployments[0].progress, { files_done: 12, files_total: 38 });
    assert.equal(out.usable, false);
    assert.equal(out.local_path, null, "ein Pfad aus syncing ist nicht verwendbar");
    assert.equal(out.next_action.action, "wait");
  } finally {
    mock.restore();
  }
});

test("sources_describe: ready liefert den lokalen Pfad", async () => {
  const mock = installFetchMock((url) => Promise.resolve(
    url.includes("/status?")
      ? ok({
        source_id: "src_1", connection_status: "active",
        deployments: [{ machine: HOST, state: "ready", local_path: "/mirror/preise", scope_summary: {} }],
      })
      : ok({ source: { remote_path: "/Shared/Preise" } })
  ));
  try {
    const out = jsonOf(await handleSourcesTool("sources_describe", { source_id: "src_1" }));
    assert.equal(out.usable, true);
    assert.equal(out.local_path, "/mirror/preise");
    assert.equal(out.next_action, null);
  } finally {
    mock.restore();
  }
});

test("sources_prepare: refresh anfordern und die Sitzungs-Zuordnung VEREINIGEN, nicht ersetzen", async () => {
  const calls = [];
  const mock = installFetchMock((url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/refresh")) {
      return Promise.resolve(ok({ job_id: "job_1", created: true, state: "queued" }, 202));
    }
    if (init.method === "PUT") {
      return Promise.resolve(ok({ sources: [
        { source_id: "src_old", generation: 1, state: "ready" },
        { source_id: "src_1", generation: 1, state: "queued" },
      ] }));
    }
    return Promise.resolve(ok({ sources: [{ source_id: "src_old" }] }));
  });
  try {
    const out = jsonOf(await handleSourcesTool("sources_prepare", {
      source_id: "src_1", session_id: "sess-self", machine: "kwhive-1",
    }));
    assert.equal(out.ok, true);
    assert.equal(out.job_id, "job_1");
    assert.equal(out.state, "queued");
    assert.equal(out.local_path, null);
    assert.equal(out.usable, false);
    assert.equal(out.next_action.action, "wait");
    assert.equal(out.session_id, "sess-self");
    assert.equal(out.session_source, "explicit");

    const put = calls.find((c) => c.method === "PUT");
    assert.ok(put, "die Zuordnung wurde geschrieben");
    assert.deepEqual(put.body.source_ids, ["src_old", "src_1"]);
    assert.equal(put.body.machine, "kwhive-1");
  } finally {
    mock.restore();
  }
});

test("sources_prepare: ohne lesbare Zuordnung wird NICHTS geschrieben", async () => {
  const calls = [];
  const mock = installFetchMock((url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    if (url.endsWith("/refresh")) return Promise.resolve(ok({ job_id: "job_1", state: "queued" }, 202));
    return Promise.resolve(refusal(500, { error: "the sources could not be read" }));
  });
  try {
    const out = jsonOf(await handleSourcesTool("sources_prepare", { source_id: "src_1", session_id: "sess-self" }));
    assert.equal(out.ok, false);
    assert.equal(out.job_id, "job_1");
    assert.equal(calls.some((c) => c.method === "PUT"), false, "kein PUT auf einer geratenen Zuordnung");
  } finally {
    mock.restore();
  }
});

test("Ablehnung: der Text des Relays bleibt im Wortlaut, die Handlung kommt aus action/next_step", async () => {
  const mock = installFetchMock(() => Promise.resolve(refusal(409, {
    error: "the connection behind this source is not active -- reconnect",
    action: "reconnect",
    next_step: "Verbindung erneuern",
  })));
  try {
    const out = jsonOf(await handleSourcesTool("sources_prepare", { source_id: "src_1", session_id: "sess-self" }));
    assert.equal(out.ok, false);
    assert.equal(out.reason, "the connection behind this source is not active -- reconnect");
    assert.deepEqual(out.next_action, { action: "reconnect", next_step: "Verbindung erneuern" });
  } finally {
    mock.restore();
  }
});

test("sources_status: liest nur, wartet nicht, und gibt den Pfad erst ab ready/partial", async () => {
  let state = "ready";
  const mock = installFetchMock(() => Promise.resolve(ok({
    source_id: "src_1", connection_status: "active",
    deployments: [{ machine: HOST, state, progress: state === "ready" ? null : { done: 3, total: 9 }, local_path: "/mirror/preise" }],
  })));
  try {
    const ready = jsonOf(await handleSourcesTool("sources_status", { source_id: "src_1", job_id: "job_1" }));
    assert.equal(ready.state, "ready");
    assert.equal(ready.local_path, "/mirror/preise");
    assert.equal(ready.job_id, "job_1");

    state = "partial";
    const partial = jsonOf(await handleSourcesTool("sources_status", { source_id: "src_1" }));
    assert.equal(partial.usable, true);
    assert.equal(partial.local_path, "/mirror/preise");
    assert.equal(partial.next_action.action, "refresh", "unvollständig wird benannt");

    state = "syncing";
    const syncing = jsonOf(await handleSourcesTool("sources_status", { source_id: "src_1" }));
    assert.equal(syncing.local_path, null);
    assert.equal(syncing.usable, false);
    assert.equal(syncing.next_action.action, "wait");
  } finally {
    mock.restore();
  }
});

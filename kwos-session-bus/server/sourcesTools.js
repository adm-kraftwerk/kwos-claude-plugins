// M365 sources (WI 11624454) -- the agent's window into the documents a person connected.
//
// WHY THIS FILE LIVES IN THIS PLUGIN. The session context this needs is already resolved here:
// which relay, which bearer, which Claude Code session. A second sources plugin would have to
// duplicate that resolution (and with it a second place that can forget the token), so the four
// tools are appended to the existing stdio server the same way codeTools.js and botMemory.js are.
//
// WHAT THIS IS NOT. It does not store sources, does not talk to Microsoft and holds no credential.
// The gateway owns the connection (OAuth, refresh token, Graph); this file only calls its routes
// with the person's own bearer and turns the answer into a SHORT statement. File lists and the
// full deployment rows stay in the gateway -- an agent asking "which sources do I have" must not
// receive a directory tree.
//
// THE MACHINE IS LOCAL. `os.hostname()` is the caller's own computer, never a value the model may
// invent; an explicit `machine` argument is the one exception and is marked as such in every
// answer, so a reader can tell a measured fact from a named one.
//
// PATHS ARE ONLY USABLE WHEN THE STATE SAYS SO. `ready` and `partial` are the two states where a
// mirror exists on this machine; everything else returns `local_path: null` plus the next step.
// Reporting a path from `queued`/`syncing`/`error` would send an agent to read a half-written
// directory.

import { hostname } from "node:os";

import { ensureSessionId } from "./config.js";
import { call } from "./relay-client.js";

/** The states in which a mirror on this machine can be read. */
const USABLE_STATES = new Set(["ready", "partial"]);

/** The relay's closed vocabulary for a source kind (`relay/m365Rules.js`). */
const SOURCE_KINDS = ["onedrive", "sharepoint"];

const MACHINE = {
  type: "string",
  description:
    "Optional: der Rechner, auf den sich die Frage bezieht. Ohne Angabe der eigene Rechner " +
    "(os.hostname()). Nur setzen, wenn der Mensch ausdrücklich einen anderen Rechner nennt -- " +
    "die Antwort kennzeichnet ihn dann als ausdrücklich genannt.",
};

const SOURCE_ID = {
  type: "string",
  description: "source_id aus sources_find",
};

export const SOURCES_TOOLS = [
  {
    name: "sources_find",
    description:
      "Findet die verbundenen Unterlagen (OneDrive/SharePoint) dieses Menschen, die auf einem " +
      "Rechner als Quelle eingerichtet sind. Kurze Liste mit source_id, Titel, Alias, Art, Pfad " +
      "und dem Zustand der Microsoft-Verbindung -- KEINE Dateibestände. Vor jedem Zugriff auf " +
      "verbundene Unterlagen zuerst hier suchen; erst wenn kein eindeutiger Treffer bleibt, den " +
      "Menschen fragen. Mit `query` wird über Titel, Alias, Pfad und source_id gesucht.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Suchtext (Teilzeichenkette, Groß-/Kleinschreibung egal)" },
        kind: { type: "string", enum: SOURCE_KINDS, description: "Nur Quellen dieser Art" },
        machine: MACHINE,
      },
      additionalProperties: false,
    },
  },
  {
    name: "sources_describe",
    description:
      "Beschreibt EINE Quelle: Umfang (Pfad und was der Abgleich umfasst), Herkunft (Microsoft-" +
      "Konto und Zustand der Verbindung) und den Stand auf diesem Rechner (Zustand, Fortschritt, " +
      "lokaler Pfad). Der lokale Pfad ist nur bei `ready` oder `partial` verwendbar; sonst sagt " +
      "die Antwort, was als Nächstes zu tun ist.",
    inputSchema: {
      type: "object",
      properties: {
        source_id: SOURCE_ID,
        machine: MACHINE,
      },
      required: ["source_id"],
      additionalProperties: false,
    },
  },
  {
    name: "sources_prepare",
    description:
      "Macht eine Quelle für DIESE Sitzung bereit: fordert einen Abgleich auf diesem Rechner an " +
      "(idempotent) und trägt die Quelle in die Zuordnung der Sitzung ein, ohne die dort schon " +
      "eingetragenen Quellen zu verlieren. Der Aufruf wartet nicht auf den Abgleich -- er nennt " +
      "job_id und Zustand, und sources_status sagt danach, wann der Pfad verwendbar ist. Erst " +
      "nach `ready`/`partial` mit dem zurückgegebenen Pfad arbeiten.",
    inputSchema: {
      type: "object",
      properties: {
        source_id: SOURCE_ID,
        session_id: {
          type: "string",
          description:
            "Optional: Claude-Code-Sitzung, der die Quelle zugeordnet wird. Ohne Angabe die " +
            "Sitzung dieses MCP-Servers (die einzige, die er sicher kennt).",
        },
        machine: MACHINE,
      },
      required: ["source_id"],
      additionalProperties: false,
    },
  },
  {
    name: "sources_status",
    description:
      "Liest den Stand einer Quelle auf diesem Rechner: Zustand, Fortschritt und den lokalen " +
      "Pfad -- Letzteren nur bei `ready`/`partial`. Blockiert nicht und wartet nicht: wer den " +
      "Abgleich angestoßen hat, fragt hier später erneut. `job_id` wird nur zur Zuordnung " +
      "mitgegeben, die Antwort kommt aus dem Zustand der Quelle.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Optional: job_id aus sources_prepare (nur zur Zuordnung)" },
        source_id: SOURCE_ID,
        machine: MACHINE,
      },
      required: ["source_id"],
      additionalProperties: false,
    },
  },
];

export const SOURCES_TOOL_NAMES = new Set(SOURCES_TOOLS.map((t) => t.name));

const text = (t) => ({ content: [{ type: "text", text: t }] });
const json = (v) => text(JSON.stringify(v, null, 2));

/**
 * The machine this question is about. `os.hostname()` unless the caller named one -- and the
 * answer says which of the two it was, because "run on this laptop" and "run on the VM the person
 * named" produce two different pictures of the same source.
 */
function resolveMachine(raw) {
  const explicit = typeof raw === "string" ? raw.trim() : "";
  if (explicit !== "") return { machine: explicit, machineSource: "explicit" };
  return { machine: hostname(), machineSource: "hostname" };
}

/** The deployment row for THIS machine, or null when nothing was mirrored here yet. */
function deploymentOn(deployments, machine) {
  return (Array.isArray(deployments) ? deployments : []).find((d) => d?.machine === machine) ?? null;
}

/** `available` is the relay's word for "the source exists, nothing is materialised here". */
function stateOf(deployment) {
  return deployment && typeof deployment.state === "string" ? deployment.state : "available";
}

/** What a person (or an agent) can do about a state -- the relay's own action vocabulary. */
const NEXT_STEP = {
  connect: "Microsoft-Konto verbinden",
  reconnect: "Verbindung erneuern",
  refresh: "Abgleich erneut anfordern",
  admin: "Administrator um Freigabe bitten",
  wait: "Später erneut versuchen",
  support: "Angaben an den Support weitergeben",
};

function actionForState(state) {
  switch (state) {
    case "ready":
      return null;
    case "partial":
      // Readable, but not complete: the path may be used AND the gap must be named.
      return { action: "refresh", next_step: "Stand ist unvollständig -- Abgleich erneut anfordern" };
    case "queued":
    case "syncing":
    case "throttled":
    case "offline":
      return { action: "wait", next_step: NEXT_STEP.wait };
    case "stale":
    case "available":
    case "error":
      return { action: "refresh", next_step: NEXT_STEP.refresh };
    case "access_denied":
    case "revoked":
      return { action: "reconnect", next_step: NEXT_STEP.reconnect };
    default:
      return { action: "support", next_step: NEXT_STEP.support };
  }
}

/**
 * The relay's refusal, verbatim, plus the action it named. The routes answer
 * `{error, action, next_step, ...}` (relay/m365Routes.js `refuse`); `call()` attaches that body to
 * the thrown error, so nothing here has to parse a sentence.
 */
function actionFromMessage(status, message) {
  const t = String(message ?? "").toLowerCase();
  if (t.includes("connect a microsoft account") || t.includes("no access token")) return "connect";
  if (t.includes("sites.read")) return "reconnect";
  if (t.includes("reauth") || t.includes("not active") || status === 401) return "reconnect";
  if (status === 404 || t.includes("no such source") || t.includes("no deployment on this machine")) return "refresh";
  if (t.includes("no deployment") || t.includes("not usable on this machine")) return "refresh";
  if (t.includes("not configured") || t.includes("kwos_relay_url")) return "admin";
  if (status === 429 || status === 503 || (typeof status === "number" && status >= 500)) return "wait";
  return "support";
}

function failure(err, extra = {}) {
  const body = err && typeof err === "object" && err.body && typeof err.body === "object" ? err.body : null;
  const status = typeof err?.status === "number" ? err.status : null;
  const reason = body && typeof body.error === "string" ? body.error : String(err?.message ?? err);
  const action = body && typeof body.action === "string" ? body.action : actionFromMessage(status, reason);
  const nextStep = body && typeof body.next_step === "string" ? body.next_step : NEXT_STEP[action] ?? null;
  return {
    ok: false,
    reason,
    next_action: { action, next_step: nextStep },
    ...(body && Array.isArray(body.missing) ? { missing: body.missing } : {}),
    ...extra,
  };
}

function sourcesPath(sourceId) {
  return `/v1/m365/sources/${encodeURIComponent(sourceId)}`;
}

function statusPath(sourceId, machine) {
  return `${sourcesPath(sourceId)}/status?machine=${encodeURIComponent(machine)}`;
}

function sessionSourcesPath(sessionId, machine) {
  const base = `/v1/m365/sessions/${encodeURIComponent(sessionId)}/sources`;
  return machine ? `${base}?machine=${encodeURIComponent(machine)}` : base;
}

/** A short one-machine view of a deployment -- never the whole row, never files. */
function shortDeployment(deployment, machine) {
  if (!deployment) return null;
  return {
    machine,
    state: stateOf(deployment),
    progress: deployment.progress ?? null,
    local_path: USABLE_STATES.has(stateOf(deployment)) ? deployment.local_path ?? null : null,
    generation: deployment.generation ?? null,
    last_success_at: deployment.last_success_at ?? null,
    error: deployment.error ?? null,
  };
}

async function find(args) {
  const { machine, machineSource } = resolveMachine(args.machine);
  const kind = typeof args.kind === "string" ? args.kind.trim() : "";
  if (kind !== "" && !SOURCE_KINDS.includes(kind)) {
    return {
      ok: false,
      reason: `Unbekannte Art "${kind}" -- erlaubt sind ${SOURCE_KINDS.join(", ")}.`,
      next_action: { action: "support", next_step: NEXT_STEP.support },
      machine,
      machine_source: machineSource,
    };
  }
  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";

  try {
    const { data } = await call(`/v1/m365/sources?machine=${encodeURIComponent(machine)}`);
    const rows = Array.isArray(data?.sources) ? data.sources : [];
    const sources = rows
      .filter((s) => (kind === "" ? true : s?.kind === kind))
      .filter((s) => {
        if (!query) return true;
        return [s?.source_id, s?.title, s?.alias, s?.remote_path, s?.kind]
          .some((v) => typeof v === "string" && v.toLowerCase().includes(query));
      })
      .map((s) => {
        const state = stateOf(deploymentOn(s?.deployments, machine));
        return {
          source_id: s?.source_id ?? null,
          title: s?.title ?? "",
          alias: s?.alias ?? "",
          kind: s?.kind ?? null,
          remote_path: s?.remote_path ?? null,
          source_status: s?.connection_status ?? null,
          state,
          usable: USABLE_STATES.has(state),
        };
      });

    return {
      ok: true,
      machine,
      machine_source: machineSource,
      // The relay's own counts for this machine, so the agent does not have to add them up.
      summary: data?.summary ?? null,
      sources,
      ...(sources.length === 0
        ? { message: "Keine Quelle passt. Filter lockern -- oder, wenn noch keine Quelle eingerichtet ist, zuerst eine Microsoft-Verbindung herstellen." }
        : {}),
    };
  } catch (err) {
    return failure(err, { machine, machine_source: machineSource });
  }
}

async function describe(args) {
  const { machine, machineSource } = resolveMachine(args.machine);
  const sourceId = typeof args.source_id === "string" ? args.source_id.trim() : "";
  if (sourceId === "") {
    return {
      ok: false,
      reason: "source_id fehlt.",
      next_action: { action: "refresh", next_step: "Mit sources_find die source_id holen" },
      machine,
      machine_source: machineSource,
    };
  }

  try {
    // The status route carries the deployments; the source route carries `remote_path` (the status
    // answer does not, and inventing the field would be worse than the extra call). Both are read
    // in parallel: a failed detail call must not cost the state.
    const [{ data }, detail] = await Promise.all([
      call(statusPath(sourceId, machine)),
      call(sourcesPath(sourceId))
        .then(({ data: body }) => body?.source ?? null)
        .catch(() => null),
    ]);
    const deployment = deploymentOn(data?.deployments, machine);
    const state = stateOf(deployment);
    const usable = USABLE_STATES.has(state);
    return {
      ok: true,
      source_id: data?.source_id ?? sourceId,
      title: data?.title ?? "",
      kind: data?.kind ?? null,
      machine,
      machine_source: machineSource,
      remote_path: data?.remote_path ?? detail?.remote_path ?? null,
      scope_summary: deployment?.scope_summary ?? null,
      connection_upn: data?.connection_upn ?? null,
      connection_status: data?.connection_status ?? null,
      // `deployments[]` as the task names it, narrowed to THIS machine: a detail panel open on
      // "dieser Rechner" must not count a mirror that stands elsewhere.
      deployments: deployment ? [shortDeployment(deployment, machine)] : [],
      local_path: usable ? deployment?.local_path ?? null : null,
      usable,
      next_action: actionForState(state),
      summary: data?.summary ?? null,
      ...(detail === null
        ? { remote_path_note: "Der Pfad war nicht abrufbar; Zustand und Umfang stammen aus der Status-Antwort." }
        : {}),
    };
  } catch (err) {
    return failure(err, { source_id: sourceId, machine, machine_source: machineSource });
  }
}

async function prepare(args) {
  const { machine, machineSource } = resolveMachine(args.machine);
  const sourceId = typeof args.source_id === "string" ? args.source_id.trim() : "";
  if (sourceId === "") {
    return {
      ok: false,
      reason: "source_id fehlt.",
      next_action: { action: "refresh", next_step: "Mit sources_find die source_id holen" },
      machine,
      machine_source: machineSource,
    };
  }

  // (a) The refresh is idempotent: an open job comes back instead of a second one. A 202 is a
  // successful answer (`call()` treats it so), and its `state` is the deployment's, not ours.
  let refreshed;
  try {
    const { data } = await call(`${sourcesPath(sourceId)}/refresh`, { method: "POST", body: { machine } });
    refreshed = data ?? {};
  } catch (err) {
    return failure(err, { source_id: sourceId, machine, machine_source: machineSource });
  }

  const jobId = refreshed.job_id ?? null;
  const refreshState = typeof refreshed.state === "string" ? refreshed.state : "queued";
  const base = {
    ok: true,
    source_id: sourceId,
    machine,
    machine_source: machineSource,
    job_id: jobId,
    state: refreshState,
    local_path: USABLE_STATES.has(refreshState) ? refreshed.local_path ?? null : null,
    usable: USABLE_STATES.has(refreshState),
    next_action: actionForState(refreshState),
  };

  // (b) The assignment is a SET, and PUT replaces it. Read the current one first and send the
  // UNION; sending only the new id would silently drop every other source this session reads.
  const explicitSession = typeof args.session_id === "string" ? args.session_id.trim() : "";
  const sessionId = explicitSession !== "" ? explicitSession : await ensureSessionId();
  if (!sessionId) {
    return {
      ...base,
      ok: false,
      reason: "Keine Sitzung bekannt -- keine source_id kann zugeordnet werden.",
      next_action: { action: "support", next_step: NEXT_STEP.support },
    };
  }

  let existing;
  try {
    const { data } = await call(sessionSourcesPath(sessionId, machine));
    existing = (Array.isArray(data?.sources) ? data.sources : [])
      .map((s) => s?.source_id)
      .filter((id) => typeof id === "string" && id !== "");
  } catch (err) {
    // Without the current assignment a PUT would wipe it. Stop here and name the reason; the
    // refresh above already ran and its job_id stays in the answer.
    return {
      ...failure(err, { source_id: sourceId, machine, machine_source: machineSource }),
      session_id: sessionId,
      job_id: jobId,
      state: refreshState,
    };
  }

  const sourceIds = [...new Set([...existing, sourceId])];
  let assigned;
  try {
    const { data } = await call(sessionSourcesPath(sessionId), {
      method: "PUT",
      body: { source_ids: sourceIds, machine },
    });
    assigned = Array.isArray(data?.sources) ? data.sources : [];
  } catch (err) {
    return {
      ...failure(err, { source_id: sourceId, machine, machine_source: machineSource }),
      session_id: sessionId,
      job_id: jobId,
      state: refreshState,
    };
  }

  return {
    ...base,
    session_id: sessionId,
    // Whether the session id came from the caller or from this process's own marker.
    session_source: explicitSession !== "" ? "explicit" : "marker",
    assigned: assigned.map((s) => ({
      source_id: s?.source_id ?? null,
      generation: s?.generation ?? null,
      state: s?.state ?? null,
    })),
  };
}

async function status(args) {
  const { machine, machineSource } = resolveMachine(args.machine);
  const sourceId = typeof args.source_id === "string" ? args.source_id.trim() : "";
  if (sourceId === "") {
    return {
      ok: false,
      reason: "source_id fehlt.",
      next_action: { action: "refresh", next_step: "Mit sources_find die source_id holen" },
      machine,
      machine_source: machineSource,
    };
  }
  const jobId = typeof args.job_id === "string" && args.job_id.trim() !== "" ? args.job_id.trim() : null;

  try {
    const { data } = await call(statusPath(sourceId, machine));
    const deployment = deploymentOn(data?.deployments, machine);
    const state = stateOf(deployment);
    const usable = USABLE_STATES.has(state);
    return {
      ok: true,
      source_id: data?.source_id ?? sourceId,
      machine,
      machine_source: machineSource,
      ...(jobId ? { job_id: jobId } : {}),
      state,
      progress: deployment?.progress ?? null,
      local_path: usable ? deployment?.local_path ?? null : null,
      usable,
      next_action: actionForState(state),
      connection_upn: data?.connection_upn ?? null,
      connection_status: data?.connection_status ?? null,
      summary: data?.summary ?? null,
    };
  } catch (err) {
    return failure(err, {
      source_id: sourceId,
      machine,
      machine_source: machineSource,
      ...(jobId ? { job_id: jobId } : {}),
    });
  }
}

export async function handleSourcesTool(name, args = {}) {
  switch (name) {
    case "sources_find":
      return json(await find(args));
    case "sources_describe":
      return json(await describe(args));
    case "sources_prepare":
      return json(await prepare(args));
    case "sources_status":
      return json(await status(args));
    default:
      throw new Error(`Unbekanntes Tool: ${name}`);
  }
}

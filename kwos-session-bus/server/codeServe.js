// kwcollab code exchange (WI 11517979) -- the network side of one session.
//
//   relayAdapter   the relay calls codeExchange.js needs (JSON and raw bodies), with the bearer
//   fetchLive      `git fetch` of another member's snapshot through the relay (Smart HTTP)
//   startServing   the back channel: the relay hands this session git requests of the others, and
//                  this session answers them with its own `git upload-pack`
//
// WHAT ANOTHER MEMBER CAN READ. `git upload-pack` runs with every ref hidden except
// refs/kwcollab/<collab>/out, and with no `want` of an unadvertised object allowed. The others can
// fetch exactly the snapshot this session published -- not the branches, not the stash, not another
// collab's state. tests/codeServe.test.js runs `git ls-remote` and a forged `want` against it.

import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitText, outRef, inRef } from "./codeGit.js";

const enc = encodeURIComponent;
const COLLAB_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The relay calls of the code exchange, with one error shape. */
export function relayAdapter({ relayUrl, getToken, fetchImpl = fetch }) {
  async function request(method, path, { json, raw, headers = {}, expect = "json" } = {}) {
    const token = await getToken();
    const res = await fetchImpl(`${relayUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : raw,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text;
      try { const p = JSON.parse(text); if (p?.error) detail = p.error; } catch { /* raw text */ }
      const err = new Error(`Relay ${method} ${path} -> ${res.status}: ${detail}`);
      err.status = res.status;
      throw err;
    }
    if (expect === "raw") return Buffer.from(await res.arrayBuffer());
    if (res.status === 204) return null;
    return res.json();
  }
  return {
    get: (path) => request("GET", path),
    post: (path, json) => request("POST", path, { json }),
    put: (path, json) => request("PUT", path, { json }),
    postRaw: (path, raw, headers) => request("POST", path, { raw, headers }),
    getRaw: (path) => request("GET", path, { expect: "raw" }),
  };
}

/**
 * The git pass-through URL of one TARGET address. `session` names the serving session (a person may
 * serve from two boxes), and without it the relay falls back to the person's newest session.
 */
export function gitFetchUrl(relayUrl, collabId, member, sessionId = null) {
  const target = typeof member === "string" ? { subject: member } : member;
  const session = sessionId ?? target?.sessionId ?? target?.session_id ?? null;
  const path = `${relayUrl}/v1/collabs/${enc(collabId)}/git/${enc(target?.subject)}`;
  return session ? `${path}?session=${enc(session)}` : path;
}

/**
 * `git fetch` of a member's snapshot through the relay. The bearer travels in `http.extraHeader`
 * set through GIT_CONFIG_* in the ENVIRONMENT -- a `-c` on the command line would put the token
 * into every process listing on the machine.
 *
 * `sessionId` is THIS address: the relay compares it with the session it handed the request to, so
 * two sessions of one person can serve two projects without answering each other's fetches.
 */
export function makeFetchLive({ relayUrl, getToken, sessionId = null }) {
  return async (ctx, collabId, member) => {
    const token = await getToken();
    const target = typeof member === "string" ? { subject: member } : member;
    const url = gitFetchUrl(relayUrl, collabId, target);
    const config = [
      ["http.extraHeader", `Authorization: Bearer ${token}`],
      ["credential.helper", ""],
      ...(sessionId ? [["http.extraHeader", `X-Kwcollab-Session: ${sessionId}`]] : []),
    ];
    const env = { GIT_CONFIG_COUNT: String(config.length) };
    config.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key;
      env[`GIT_CONFIG_VALUE_${i}`] = value;
    });
    const r = await git(ctx.top, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", url, `+${outRef(collabId)}:${inRef(collabId, target.subject)}`], { env, timeoutMs: 60000 });
    if (r.code !== 0) throw new Error(`live fetch failed: ${r.stderr.trim().replace(token, "***")}`);
    return gitText(ctx.top, ["rev-parse", inRef(collabId, target.subject)]);
  };
}

// The config that confines upload-pack to ONE ref. hideRefs with a `!` exception: everything under
// refs/ is hidden except this collab's out ref (git applies the last matching rule).
export function uploadPackConfig(collabId) {
  return [
    "-c", "uploadpack.hideRefs=refs/",
    "-c", "uploadpack.hideRefs=HEAD",
    "-c", `uploadpack.hideRefs=!${outRef(collabId)}`,
    "-c", "uploadpack.allowTipSHA1InWant=false",
    "-c", "uploadpack.allowReachableSHA1InWant=false",
    "-c", "uploadpack.allowAnySHA1InWant=false",
    "-c", "uploadpack.allowFilter=false",
  ];
}

/**
 * The repository upload-pack really serves: a bare repository under <git-dir>/kwcollab/serve-<collab>.git
 * whose object store is the worktree's (objects/info/alternates) and whose ONLY ref is the out ref.
 * Its HEAD points at that ref too.
 *
 * WHY A SECOND REPOSITORY. hideRefs hides the branches, but upload-pack still announces
 * `symref=HEAD:refs/heads/<branch>` from the real repository's HEAD (git 2.42, measured in
 * tests/codeServe.test.js). A repository that has no branch cannot name one -- the boundary is
 * structural, and the hideRefs config stays as a second line.
 */
export async function serveRepo(top, collabId) {
  const gitDir = await gitText(top, ["rev-parse", "--absolute-git-dir"]);
  const common = await gitText(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const dir = join(gitDir, "kwcollab", `serve-${collabId}.git`);
  if (!existsSync(join(dir, "HEAD"))) {
    mkdirSync(dir, { recursive: true });
    await gitText(dir, ["init", "-q", "--bare"]);
    mkdirSync(join(dir, "objects", "info"), { recursive: true });
  }
  writeFileSync(join(dir, "objects", "info", "alternates"), `${join(common, "objects").replace(/\\/g, "/")}\n`);
  const head = await git(top, ["rev-parse", "--verify", "-q", outRef(collabId)]);
  if (head.code === 0) {
    await gitText(dir, ["update-ref", outRef(collabId), head.stdout.toString().trim()]);
  }
  await gitText(dir, ["symbolic-ref", "HEAD", outRef(collabId)]);
  return dir;
}

/** Run upload-pack for one Smart HTTP request; resolves the response body. */
export async function runUploadPack(top, collabId, opts) {
  const dir = await serveRepo(top, collabId);
  return uploadPackIn(dir, collabId, opts);
}

function uploadPackIn(dir, collabId, { kind, body, gitProtocol }) {
  const top = dir;
  return new Promise((resolve, reject) => {
    const args = [...uploadPackConfig(collabId), "upload-pack", "--stateless-rpc"];
    if (kind === "advertise") args.push("--advertise-refs");
    args.push(".");
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) delete env[k];
    if (gitProtocol && /^version=[0-9]$/.test(gitProtocol)) env.GIT_PROTOCOL = gitProtocol;
    const child = spawn("git", args, { cwd: top, env, windowsHide: true });
    const out = [];
    const err = [];
    let size = 0;
    const max = 32 * 1024 * 1024;
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on("data", (c) => {
      size += c.length;
      if (size > max) { child.kill(); return; }
      out.push(c);
    });
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > max) {
        return reject(new Error(`upload-pack ${code}: ${Buffer.concat(err).toString("utf8").trim().slice(0, 300)}`));
      }
      let payload = Buffer.concat(out);
      // The smart protocol's advertisement starts with the service announcement; git-http-backend
      // writes it, `--stateless-rpc --advertise-refs` does not.
      if (kind === "advertise") {
        const line = "# service=git-upload-pack\n";
        const pkt = (line.length + 4).toString(16).padStart(4, "0") + line;
        payload = Buffer.concat([Buffer.from(pkt), Buffer.from("0000"), payload]);
      }
      resolve(payload);
    });
    child.stdin.end(body && body.length ? body : undefined);
  });
}

/**
 * Answer one request frame from the back channel. Kept separate from the stream so the test can
 * drive it without a relay.
 */
// A git upload-pack request is wants and haves -- small. The relay caps the compressed body at
// 1 MiB, but a gzip body can inflate a thousandfold (review finding 2026-10-20), so the inflated size
// has its own cap: a request beyond it is refused, not inflated.
export const SERVE_REQUEST_INFLATED_MAX = 8 * 1024 * 1024;

export async function answerServeFrame(top, collabId, frame) {
  if (!COLLAB_UUID_RE.test(String(collabId))) throw new Error("collab id invalid");
  let body = frame.body_b64 ? Buffer.from(frame.body_b64, "base64") : Buffer.alloc(0);
  if (frame.gzip) body = gunzipSync(body, { maxOutputLength: SERVE_REQUEST_INFLATED_MAX });
  return runUploadPack(top, collabId, { kind: frame.kind, body, gitProtocol: frame.git_protocol });
}

/**
 * Hold the back channel open for as long as `signal` is not aborted. Every `event: request` frame
 * is answered by `upload-pack`; a failure answers with a status the relay passes on as 502.
 */
export async function startServing({ relayUrl, getToken, collabId, sessionId = null, top, signal, runSse, fetchImpl = fetch, onError = () => {} }) {
  // The back channel belongs to THIS session: two sessions of one person serve two projects, and a
  // stream without the address would be handed the other one's git requests.
  const query = sessionId ? `?session=${enc(sessionId)}` : "";
  const url = `${relayUrl}/v1/collabs/${enc(collabId)}/code/serve${query}`;
  await runSse(async (data, event) => {
    if (event !== "request") return;
    let frame;
    try { frame = JSON.parse(data); } catch { return; }
    if (!frame || !/^[0-9a-f]{32}$/.test(String(frame.rid))) return;
    let status = 200;
    let payload;
    try {
      payload = await answerServeFrame(top, collabId, frame);
    } catch (e) {
      status = 500;
      payload = Buffer.from(String(e?.message || e));
      onError(e);
    }
    try {
      const token = await getToken();
      await fetchImpl(`${relayUrl}/v1/collabs/${enc(collabId)}/code/serve/${frame.rid}${query}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "X-Kwcollab-Status": String(status),
          ...(sessionId ? { "X-Kwcollab-Session": sessionId } : {}),
        },
        body: payload,
      });
    } catch (e) { onError(e); }
  }, { signal, url });
}

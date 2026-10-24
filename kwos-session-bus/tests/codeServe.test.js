// kwcollab code exchange (WI 11517979): what another member can read from THIS session's
// upload-pack. Real git, no relay: the frame is answered the way the back channel answers it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitText } from "../server/codeGit.js";
import { answerServeFrame, uploadPackConfig, gitFetchUrl } from "../server/codeServe.js";
import { parseEvent } from "../server/sse-receiver.js";

const COLLAB = "0c5d9b7e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const OTHER = "11111111-2222-4333-8444-555555555555";

async function repo() {
  const dir = mkdtempSync(join(tmpdir(), "kwcode-serve-"));
  await gitText(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  await gitText(dir, ["add", "-A"]);
  await gitText(dir, ["-c", "user.name=a", "-c", "user.email=a@x", "commit", "-q", "-m", "secret-branch-content"]);
  await gitText(dir, ["branch", "private-work"]);
  await gitText(dir, ["update-ref", `refs/kwcollab/${COLLAB}/out`, "HEAD"]);
  await gitText(dir, ["update-ref", `refs/kwcollab/${OTHER}/out`, "HEAD"]);
  await gitText(dir, ["update-ref", "refs/stash", "HEAD"]);
  return dir;
}

function pktLines(buf) {
  const lines = [];
  let i = 0;
  const s = buf.toString("latin1");
  while (i + 4 <= s.length) {
    const n = parseInt(s.slice(i, i + 4), 16);
    if (n === 0) { lines.push(""); i += 4; continue; }
    lines.push(s.slice(i + 4, i + n));
    i += n;
  }
  return lines;
}

test("die Ankuendigung nennt genau einen Ref -- den des eigenen Collabs, keinen Branch, keinen Stash, kein HEAD-Ziel", async () => {
  const dir = await repo();
  try {
    const adv = await answerServeFrame(dir, COLLAB, { kind: "advertise", body_b64: "" });
    const lines = pktLines(adv).filter(Boolean);
    assert.equal(lines[0], "# service=git-upload-pack\n");
    const refs = lines.slice(1).map((l) => l.split("\0")[0].trim().split(" ")[1]);
    assert.deepEqual(refs, [`refs/kwcollab/${COLLAB}/out`]);
    const text = adv.toString("latin1");
    assert.doesNotMatch(text, /refs\/heads\//, "kein Branchname, auch nicht im symref");
    assert.doesNotMatch(text, new RegExp(OTHER));
    assert.doesNotMatch(text, /refs\/stash/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ein want auf ein nicht angekuendigtes Objekt wird abgelehnt", async () => {
  const dir = await repo();
  try {
    // A commit only reachable from a hidden branch.
    writeFileSync(join(dir, "b.txt"), "hidden\n");
    await gitText(dir, ["add", "-A"]);
    await gitText(dir, ["-c", "user.name=a", "-c", "user.email=a@x", "commit", "-q", "-m", "hidden"]);
    const hidden = await gitText(dir, ["rev-parse", "HEAD"]);
    const want = `want ${hidden} side-band-64k\n`;
    const pkt = (s) => (s.length + 4).toString(16).padStart(4, "0") + s;
    const body = Buffer.from(pkt(want) + "0000" + pkt("done\n"));
    await assert.rejects(
      () => answerServeFrame(dir, COLLAB, { kind: "rpc", body_b64: body.toString("base64") }),
      /not our ref|upload-pack/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("eine gzip-Bombe im Abrufwunsch wird abgelehnt statt entpackt", async () => {
  const { gzipSync } = await import("node:zlib");
  const dir = await repo();
  try {
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));   // ~64 KB packed, 64 MB inflated
    await assert.rejects(
      () => answerServeFrame(dir, COLLAB, { kind: "rpc", gzip: true, body_b64: bomb.toString("base64") }),
      /buffer|length|Cannot create/i,
    );
    await assert.rejects(() => answerServeFrame(dir, "../x", { kind: "advertise", body_b64: "" }), /collab id invalid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("die Konfiguration versteckt alles und oeffnet nur den eigenen out-Ref", () => {
  const cfg = uploadPackConfig(COLLAB);
  assert.ok(cfg.includes("uploadpack.hideRefs=refs/"));
  assert.ok(cfg.includes(`uploadpack.hideRefs=!refs/kwcollab/${COLLAB}/out`));
  assert.ok(cfg.includes("uploadpack.allowAnySHA1InWant=false"));
  // The exception must come AFTER the blanket rule: git applies the last matching one.
  assert.ok(cfg.indexOf("uploadpack.hideRefs=refs/") < cfg.indexOf(`uploadpack.hideRefs=!refs/kwcollab/${COLLAB}/out`));
});

test("gitFetchUrl names the TARGET session -- otherwise the relay guesses the newest address", () => {
  assert.equal(
    gitFetchUrl("https://relay", COLLAB, { subject: "kai", sessionId: "s-target" }),
    `https://relay/v1/collabs/${COLLAB}/git/kai?session=s-target`,
  );
  // Without a target session the old URL stays -- an older relay answers the person's newest one.
  assert.equal(gitFetchUrl("https://relay", COLLAB, "kai"), `https://relay/v1/collabs/${COLLAB}/git/kai`);
  // relay-side field spelling is accepted too
  assert.equal(
    gitFetchUrl("https://relay", COLLAB, { subject: "kai", session_id: "s-target" }),
    `https://relay/v1/collabs/${COLLAB}/git/kai?session=s-target`,
  );
});

test("parseEvent liefert den Ereignisnamen mit", () => {
  assert.deepEqual(parseEvent("id: 7\nevent: request\ndata: {\"rid\":1}"), { id: "7", event: "request", data: "{\"rid\":1}" });
  assert.deepEqual(parseEvent("data: x"), { id: undefined, event: undefined, data: "x" });
});

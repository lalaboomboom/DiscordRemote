import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ssh2 from "ssh2";
import { CODEX_EVENTS_SSH_COMMAND, CODEX_EVENTS_SSH_PYTHON } from "../apps/discord/codex-events-ssh.js";
import { CodexEventRequest, CodexEventResponse, readCodexEvents } from "../apps/discord/codex-events.js";
import { HostExecutor } from "../apps/discord/hosts.js";
import { AgentHostExecutor } from "../apps/discord/agent-client.js";
import { AgentHub } from "../apps/discord/agent-hub.js";
import { AgentRuntime } from "../apps/discord/agent-runtime.js";
import { runPasswordSsh } from "../apps/discord/ssh-password.js";

const { Server, utils } = ssh2;
const threadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const turnId = "12345678-aaaa-4bbb-8ccc-123456789abc";
const otherThread = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const relative = `sessions/2026/10/03/rollout-2026-10-03T12-13-14-${threadId}.jsonl`;
const privateContent = "PRIVATE_PROMPT_AND_MODEL_OUTPUT_MUST_NOT_CROSS_EVENT_TRANSPORT";
const completed = (turn = turnId) => ({ type: "event_msg", timestamp: "2026-10-03T12:13:14.123Z", payload: { type: "task_complete", turn_id: turn, completed_at: 1_791_029_594, last_agent_message: privateContent } });
const line = (value: unknown) => JSON.stringify(value) + "\n";

function fixture(cwd = "/training/project") {
  const root = mkdtempSync(join(tmpdir(), "codex-event-transport-"));
  const home = join(root, "codex"), file = join(home, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, line({ type: "session_meta", payload: { id: threadId, source: "cli", cwd } }) + line({ type: "response_item", payload: { content: privateContent } }) + line(completed()));
  return { root, home, file, cwd, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

function python(home: string, request: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", CODEX_EVENTS_SSH_PYTHON], { env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(JSON.stringify(request));
  });
}
async function scanned(home: string, request: CodexEventRequest): Promise<CodexEventResponse> {
  const result = await python(home, request);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes(privateContent));
  return JSON.parse(result.stdout);
}

test("SSH scanner matches local EOF subscription and emits only native, exact-thread completion metadata", { skip: process.platform !== "linux" }, async () => {
  const f = fixture();
  try {
    const request = { threadId, cwd: f.cwd };
    const start = await scanned(f.home, request);
    const local = await readCodexEvents(request, { codexHome: f.home, platform: "linux" });
    assert.deepEqual(start, local);
    assert.deepEqual(start.events, []); // Historical completion is not replayed.
    appendFileSync(f.file, line({ type: "response_item", payload: { content: privateContent } }) + line(completed()));
    const next = await scanned(f.home, { ...request, cursor: start.cursor });
    assert.deepEqual(next, await readCodexEvents({ ...request, cursor: start.cursor }, { codexHome: f.home, platform: "linux" }));
    assert.deepEqual(next.events, [{ turnId, completedAt: 1_791_029_594_000 }]);
    assert.deepEqual((await scanned(f.home, { ...request, cursor: next.cursor })).events, []);
    const sourceBefore = readFileSync(f.file);
    assert.equal((await python(f.home, { ...request, cwd: "/wrong-project", cursor: next.cursor })).code, 1);
    assert.equal((await python(f.home, { ...request, threadId: otherThread, cursor: next.cursor })).code, 1);
    assert.equal((await python(f.home, { ...request, cursor: { ...next.cursor, relativePath: "../../private.txt" } })).code, 1);
    assert.equal((await python(f.home, { ...request, cursor: null })).code, 1);
    assert.deepEqual(readFileSync(f.file), sourceBefore);
  } finally { f.cleanup(); }
});

test("SSH scanner honors first CLI metadata and fails closed on invalid completion timestamps", { skip: process.platform !== "linux" }, async () => {
  const f = fixture();
  try {
    const request = { threadId, cwd: f.cwd };
    const original = readFileSync(f.file, "utf8");
    writeFileSync(f.file, original.replace('"source":"cli"', '"source":{"subagent":{"parent_thread_id":"' + otherThread + '"}}'));
    assert.equal((await python(f.home, request)).code, 1);
    writeFileSync(f.file, original);
    const start = await scanned(f.home, request);
    appendFileSync(f.file, line({ type: "session_meta", payload: { id: otherThread, cwd: "/wrong", source: "cli" } }));
    appendFileSync(f.file, line({ type: "event_msg", timestamp: "2026-10-03T12:13:14.987654321Z", payload: { type: "task_complete", turn_id: turnId, last_agent_message: privateContent } }));
    const actual = await scanned(f.home, { ...request, cursor: start.cursor });
    assert.deepEqual(actual, await readCodexEvents({ ...request, cursor: start.cursor }, { codexHome: f.home, platform: "linux" }));
    appendFileSync(f.file, line({ type: "event_msg", timestamp: "2026-02-30T12:13:14Z", payload: { type: "task_complete", turn_id: turnId } }));
    const invalid = await python(f.home, { ...request, cursor: actual.cursor });
    assert.equal(invalid.code, 1); assert.ok(!invalid.stderr.includes(privateContent));
  } finally { f.cleanup(); }
});

test("SSH and local readers suppress native completion without a final answer and reject unexpected answer shapes", { skip: process.platform !== "linux" }, async () => {
  const f = fixture();
  try {
    const request = { threadId, cwd: f.cwd };
    const start = await scanned(f.home, request);
    for (const message of [undefined, null, "", " \t ", "\ufeff", "\u00a0\u2007\u2028"]) {
      appendFileSync(f.file, line({ type: "event_msg", timestamp: "2026-10-03T12:13:14.123Z", payload: { type: "task_complete", turn_id: turnId, last_agent_message: message } }));
    }
    appendFileSync(f.file, line(completed()));
    const next = await scanned(f.home, { ...request, cursor: start.cursor });
    assert.deepEqual(next, await readCodexEvents({ ...request, cursor: start.cursor }, { codexHome: f.home, platform: "linux" }));
    assert.deepEqual(next.events, [{ turnId, completedAt: 1_791_029_594_000 }]);
    appendFileSync(f.file, line({ type: "event_msg", timestamp: "2026-10-03T12:13:14.123Z", payload: { type: "task_complete", turn_id: turnId, last_agent_message: { content: privateContent } } }));
    const rejected = await python(f.home, { ...request, cursor: next.cursor });
    assert.equal(rejected.code, 1); assert.ok(!rejected.stderr.includes(privateContent));
    await assert.rejects(readCodexEvents({ ...request, cursor: next.cursor }, { codexHome: f.home, platform: "linux" }), /paused/);
  } finally { f.cleanup(); }
});

test("SSH scanner waits for complete lines, skips pre-subscription partial history, caps batches and refuses replacement", { skip: process.platform !== "linux" }, async () => {
  const f = fixture();
  try {
    const request = { threadId, cwd: f.cwd };
    const record = line(completed()), split = Math.floor(record.length / 2);
    appendFileSync(f.file, record.slice(0, split));
    const start = await scanned(f.home, request);
    appendFileSync(f.file, record.slice(split));
    const skipped = await scanned(f.home, { ...request, cursor: start.cursor });
    assert.deepEqual(skipped.events, []);
    appendFileSync(f.file, record.slice(0, split));
    const partial = await scanned(f.home, { ...request, cursor: skipped.cursor });
    assert.equal(partial.cursor.offset, skipped.cursor.offset);
    appendFileSync(f.file, record.slice(split));
    assert.equal((await scanned(f.home, { ...request, cursor: partial.cursor })).events.length, 1);
    const subscribed = await scanned(f.home, request);
    appendFileSync(f.file, Array.from({ length: 130 }, () => record).join(""));
    const batch = await scanned(f.home, { ...request, cursor: subscribed.cursor });
    assert.equal(batch.events.length, 128);
    const remaining = await scanned(f.home, { ...request, cursor: batch.cursor });
    assert.equal(remaining.events.length, 2);
    const content = readFileSync(f.file);
    renameSync(f.file, join(f.root, "replaced.jsonl")); writeFileSync(f.file, content);
    assert.equal((await python(f.home, { ...request, cursor: remaining.cursor })).code, 1);
    rmSync(f.file); symlinkSync(join(f.root, "outside.jsonl"), f.file);
    writeFileSync(join(f.root, "outside.jsonl"), content);
    assert.equal((await python(f.home, request)).code, 1);
  } finally { f.cleanup(); }
});

function hostKey() {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  const parsed = utils.parseKey(privateKey); assert.ok(!(parsed instanceof Error) && !Array.isArray(parsed));
  return { privateKey, fingerprint: "SHA256:" + createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "") };
}

test("authenticated SSH reader sends path data through stdin, uses a fixed program and validates reply identity", { skip: process.platform !== "linux", timeout: 15_000 }, async () => {
  const f = fixture("/training/' ; echo UNTRUSTED ; #");
  const key = hostKey(); let executions = 0, command = "", badIdentity = false;
  const server = new Server({ hostKeys: [key.privateKey] }, client => {
    client.on("error", () => {});
    client.on("authentication", ctx => { if (ctx.method === "password" && ctx.password === "fixture-password") ctx.accept(); else ctx.reject(); });
    client.on("ready", () => client.on("session", accept => {
      const session = accept();
      session.on("exec", (acceptExec, _rejectExec, info) => {
        executions++; command = info.command;
        const stream = acceptExec();
        if (badIdentity) { stream.on("data", () => {}); stream.on("end", () => { stream.write(JSON.stringify({ threadId: otherThread, cwd: f.cwd, cursor: { relativePath: relative, fileIdentity: "1:2:0", offset: 100 }, events: [] })); stream.exit(0); stream.end(); }); return; }
        const child = spawn("/bin/sh", ["-c", info.command], { env: { ...process.env, CODEX_HOME: f.home }, stdio: ["pipe", "pipe", "pipe"] });
        stream.pipe(child.stdin); child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream.stderr, { end: false });
        child.once("close", code => { stream.exit(code ?? 1); stream.end(); });
      });
    }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const executor = new HostExecutor({ id: "fixture", label: "fixture", kind: "ssh", cwd: "/nonexistent-do-not-use", host: "127.0.0.1", user: "fixture", port: (server.address() as { port: number }).port, password: "fixture-password", hostKeySha256: key.fingerprint }, f.root);
    const response = await executor.readCodexEvents({ threadId, cwd: f.cwd });
    assert.deepEqual(response.events, []);
    assert.equal(command, `cd -- '/' && ${CODEX_EVENTS_SSH_COMMAND}`);
    assert.ok(!command.includes(f.cwd));
    assert.ok(!command.includes(threadId));
    badIdentity = true;
    await assert.rejects(executor.readCodexEvents({ threadId, cwd: f.cwd, cursor: response.cursor }), /Invalid Codex event response/);
    await assert.rejects(executor.readCodexEvents({ threadId: "invalid", cwd: f.cwd }), /Invalid Codex event request/);
    assert.equal(executions, 2); // Rejected request never reaches SSH.
  } finally { await new Promise<void>(done => server.close(() => done())); f.cleanup(); }
});

test("event-read SSH deadline includes connection/command wait instead of the legacy diagnostic allowance", { timeout: 5000 }, async () => {
  const key = hostKey();
  const server = new Server({ hostKeys: [key.privateKey] }, client => {
    client.on("error", () => {});
    client.on("authentication", ctx => ctx.accept());
    client.on("ready", () => client.on("session", accept => accept().on("exec", acceptExec => { const stream = acceptExec(); stream.on("data", () => {}); stream.on("error", () => {}); })));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const started = Date.now();
    const result = await runPasswordSsh({ id: "fixture", label: "fixture", kind: "ssh", cwd: "/", host: "127.0.0.1", user: "fixture", port: (server.address() as { port: number }).port, password: "fixture-password", hostKeySha256: key.fingerprint }, "fixed-read", 15_000, "{}", "direct-pinned", Date.now() + 250);
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 2000);
  } finally { await new Promise<void>(done => server.close(() => done())); }
});

test("paired agent transports exact thread reads independently of terminals and rejects stale/wrong metadata", { skip: process.platform !== "linux" }, async () => {
  const f = fixture(); const priorHome = process.env.CODEX_HOME;
  const hub = new AgentHub(join(f.root, "agents.json"), "700000000000000001", "700000000000000002");
  process.env.CODEX_HOME = f.home;
  try {
    const pair = hub.enroll(hub.issuePair(), "fixture", "linux", f.root), machine = hub.authenticate(pair.machine, pair.token);
    const runtime = await AgentRuntime.start(machine.id, join(f.root, "state"), f.root), snapshot = await runtime.snapshot();
    hub.poll(machine, snapshot);
    const executor = new AgentHostExecutor(machine, hub);
    const pending = executor.readCodexEvents({ threadId, cwd: f.cwd });
    const jobs = hub.poll(machine, snapshot);
    assert.equal(jobs.length, 1); assert.equal(jobs[0].op, "codex-events");
    assert.deepEqual(jobs[0].args, { threadId, cwd: f.cwd });
    const result = await runtime.dispatch(jobs[0]); hub.result(machine, jobs[0].id, result);
    const subscription = await pending;
    assert.deepEqual(subscription.events, []);
    assert.deepEqual((await runtime.snapshot()).terminals, snapshot.terminals);
    await assert.rejects(runtime.dispatch({ ...jobs[0], id: "1".repeat(32), generation: "f".repeat(32) }), /Stale/);
    const forged = executor.readCodexEvents({ threadId, cwd: f.cwd, cursor: subscription.cursor });
    const forgedJobs = hub.poll(machine, snapshot);
    hub.result(machine, forgedJobs[0].id, { ...subscription, threadId: otherThread });
    await assert.rejects(forged, /Invalid Codex event response/);
    await assert.rejects(executor.readCodexEvents({ threadId, cwd: "D:\\wrong-machine" }), /absolute Linux/);
    assert.equal(hub.poll(machine, snapshot).length, 0);
  } finally {
    if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
    hub.close(); f.cleanup();
  }
});

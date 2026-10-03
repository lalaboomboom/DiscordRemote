import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_EVENT_LIMITS, CodexEventRequest, readCodexEvents, validCodexEventCursor, validCodexEventRequest, validCodexEventResponse } from "../apps/discord/codex-events.js";

const threadId = "01a0d176-4d1c-7233-821c-2b190fa499e2";
const parentId = "01a0fbf0-9cad-7613-8f62-d427ae4bbaa0";
const turnId = "01a0fbf0-c38b-7e50-869b-ab6b35d33f13";
const cwd = "/workspace/training";
const relative = `sessions/2026/10/03/rollout-2026-10-03T09-00-00-${threadId}.jsonl`;
const line = (value: unknown) => JSON.stringify(value) + "\n";
const metadata = (patch: Record<string, unknown> = {}) => ({ type: "session_meta", payload: {
  id: threadId, cwd, source: "cli", cli_version: "0.156.1", history_mode: "paginated",
  base_instructions: "PRIVATE_BASE_INSTRUCTIONS", ...patch,
} });
const completion = (patch: Record<string, unknown> = {}) => ({ timestamp: "2026-10-03T09:01:02.123Z", type: "event_msg", payload: {
  type: "task_complete", turn_id: turnId, completed_at: 1791018062,
  last_agent_message: "PRIVATE_REPLY\nChào bạn\n<@123456789012345678>", ...patch,
} });
function fixture(contents = line(metadata())) {
  const home = mkdtempSync(join(tmpdir(), "codex-events-"));
  const file = join(home, ...relative.split("/"));
  mkdirSync(join(home, "sessions", "2026", "10", "03"), { recursive: true });
  writeFileSync(file, contents, { mode: 0o600 });
  return { home, file, request: { threadId, cwd } as CodexEventRequest, options: { codexHome: home, platform: "linux" as const },
    close() { rmSync(home, { recursive: true, force: true }); } };
}

test("subscription starts at EOF and returns only new native completion identities, never private transcript text", async () => {
  const f = fixture(line(metadata()) + line(completion()));
  try {
    const initial = await readCodexEvents(f.request, f.options);
    assert.equal(initial.cursor.offset, statSync(f.file).size);
    assert.deepEqual(initial.events, []);
    appendFileSync(f.file, line({ type: "response_item", payload: { role: "user", content: "PRIVATE_PROMPT" } })
      + line({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } })
      + line({ type: "event_msg", payload: { type: "turn_aborted", turn_id: turnId } })
      + line(completion()));
    const result = await readCodexEvents({ ...f.request, cursor: initial.cursor }, f.options);
    assert.deepEqual(result.events, [{ turnId, completedAt: 1791018062000 }]);
    assert.equal(result.cursor.offset, statSync(f.file).size);
    assert.equal(validCodexEventResponse(result), true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|Chào|123456789012345678/);
    assert.deepEqual((await readCodexEvents({ ...f.request, cursor: result.cursor }, f.options)).events, []);
  } finally { f.close(); }
});

test("first native metadata remains authoritative when an imported parent metadata record follows", async () => {
  const f = fixture(line(metadata({ cli_version: "0.160.0" }))
    + line(metadata({ id: parentId, cwd: "/parent/project", cli_version: "0.155.1" })) + line(completion()));
  try {
    const initial = await readCodexEvents(f.request, f.options);
    appendFileSync(f.file, line(completion()));
    const result = await readCodexEvents({ ...f.request, cursor: initial.cursor }, f.options);
    assert.equal(result.threadId, threadId);
    assert.equal(result.cwd, cwd);
    assert.equal(result.events.length, 1);
    // Changing initial version does not identify which CLI/daemon currently writes this session.
    writeFileSync(f.file, line(metadata({ cli_version: "0.999.0" })));
    assert.deepEqual((await readCodexEvents(f.request, f.options)).events, []);
    await assert.rejects(readCodexEvents({ threadId: parentId, cwd: "/parent/project" }, f.options), /unavailable or unsupported/);
  } finally { f.close(); }
});

test("EOF inside an old record skips that record; new partial UTF-8 records wait for a complete line", async () => {
  const old = line(completion()).trimEnd();
  const f = fixture(line(metadata()) + old.slice(0, 70));
  try {
    const initial = await readCodexEvents(f.request, f.options);
    const fresh = Buffer.from(line(completion({ completed_at: "2026-10-03T09:01:02.123Z" })));
    const split = fresh.indexOf(Buffer.from("à")) + 1;
    assert.ok(split > 1); // Split between the two UTF-8 bytes of a private reply character.
    appendFileSync(f.file, old.slice(70) + "\n");
    appendFileSync(f.file, fresh.subarray(0, split));
    const partial = await readCodexEvents({ ...f.request, cursor: initial.cursor }, f.options);
    assert.deepEqual(partial.events, []);
    const partialOffset = partial.cursor.offset;
    assert.ok(partialOffset < statSync(f.file).size);
    assert.equal((await readCodexEvents({ ...f.request, cursor: partial.cursor }, f.options)).cursor.offset, partialOffset);
    appendFileSync(f.file, fresh.subarray(split));
    const result = await readCodexEvents({ ...f.request, cursor: partial.cursor }, f.options);
    assert.deepEqual(result.events, [{ turnId, completedAt: Date.parse("2026-10-03T09:01:02.123Z") }]);
  } finally { f.close(); }
});

test("native completion timestamps normalize seconds, milliseconds and ISO while keeping final reply text private", async () => {
  const f = fixture();
  try {
    const initial = await readCodexEvents(f.request, f.options);
    appendFileSync(f.file, line(completion({ completed_at: 1791018062123 }))
      + line(completion({ completed_at: "2026-10-03T09:01:02.123Z" }))
      + line(completion({ completed_at: undefined })));
    const result = await readCodexEvents({ ...f.request, cursor: initial.cursor }, f.options);
    assert.deepEqual(result.events.map(event => event.completedAt), [1791018062123, Date.parse("2026-10-03T09:01:02.123Z"), Date.parse("2026-10-03T09:01:02.123Z")]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_REPLY/);
  } finally { f.close(); }
});

test("native completions without a final reply advance the cursor without announcing a reply or exposing content", async () => {
  const f = fixture();
  try {
    const initial = await readCodexEvents(f.request, f.options);
    for (const reply of [undefined, null, "", " \n\t "]) appendFileSync(f.file, line(completion({ last_agent_message: reply })));
    const skipped = await readCodexEvents({ ...f.request, cursor: initial.cursor }, f.options);
    assert.deepEqual(skipped.events, []);
    assert.equal(skipped.cursor.offset, statSync(f.file).size);
    appendFileSync(f.file, line(completion()));
    const replied = await readCodexEvents({ ...f.request, cursor: skipped.cursor }, f.options);
    assert.deepEqual(replied.events, [{ turnId, completedAt: 1791018062000 }]);
    assert.doesNotMatch(JSON.stringify(replied), /PRIVATE_REPLY|Chào/);
  } finally { f.close(); }
});

test("no-reply completions still validate native identities and non-string final replies pause safely", async () => {
  for (const patch of [{ turn_id: "PRIVATE_INVALID_ID", last_agent_message: null }, { completed_at: "PRIVATE_INVALID_TIME", last_agent_message: "" },
    { last_agent_message: 42 }, { last_agent_message: false }, { last_agent_message: { content: "PRIVATE_REPLY" } }]) {
    const f = fixture();
    try {
      const initial = await readCodexEvents(f.request, f.options);
      appendFileSync(f.file, line(completion(patch)));
      await assert.rejects(readCodexEvents({ ...f.request, cursor: initial.cursor }, f.options), error =>
        error instanceof Error && /notifications are paused/.test(error.message) && !error.message.includes("PRIVATE"));
    } finally { f.close(); }
  }
});

test("unknown completion shapes and corrupt records pause safely without returning private contents", async () => {
  for (const content of [line(completion({ turn_id: "PRIVATE_INVALID_ID" })), line(completion({ completed_at: "PRIVATE_INVALID_TIME" })),
    line(completion({ completed_at: "2026-02-30T09:01:02Z" })), "PRIVATE_NOT_JSON\n"]) {
    const f = fixture();
    try {
      const initial = await readCodexEvents(f.request, f.options);
      appendFileSync(f.file, content);
      await assert.rejects(readCodexEvents({ ...f.request, cursor: initial.cursor }, f.options), error =>
        error instanceof Error && /notifications are paused/.test(error.message) && !error.message.includes("PRIVATE"));
    } finally { f.close(); }
  }
});

test("subagent sources are rejected even when they import a CLI parent's metadata", async () => {
  const f = fixture(line(metadata({ source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } } }))
    + line(metadata({ id: parentId, source: "cli" })) + line(completion()));
  try { await assert.rejects(readCodexEvents(f.request, f.options), /unavailable or unsupported/); }
  finally { f.close(); }
});

test("cwd comparison uses the target OS while preserving case-sensitive Windows directory names", async () => {
  const f = fixture();
  try {
    await assert.rejects(readCodexEvents({ ...f.request, cwd: "/workspace/other" }, f.options), /unavailable or unsupported/);
    writeFileSync(f.file, line(metadata({ cwd: "d:\\Training\\Project" })));
    const request = { threadId, cwd: "D:/Training/Project/" };
    assert.deepEqual((await readCodexEvents(request, { codexHome: f.home, platform: "win32" })).events, []);
    await assert.rejects(readCodexEvents({ ...request, cwd: "D:/training/Project" }, { codexHome: f.home, platform: "win32" }), /unavailable or unsupported/);
    await assert.rejects(readCodexEvents(request, f.options), /Invalid Codex event working directory/);
  } finally { f.close(); }
});

test("rotation and truncation invalidate cursors instead of re-reading or selecting another source", async () => {
  for (const change of ["rotate", "truncate"] as const) {
    const f = fixture(line(metadata()) + line(completion()));
    try {
      const initial = await readCodexEvents(f.request, f.options);
      if (change === "rotate") { renameSync(f.file, f.file + ".old"); writeFileSync(f.file, line(metadata()) + line(completion())); }
      else truncateSync(f.file, Buffer.byteLength(line(metadata())));
      await assert.rejects(readCodexEvents({ ...f.request, cursor: initial.cursor }, f.options), /changed or was truncated/);
    } finally { f.close(); }
  }
});

test("response batch bounds preserve the unread completion for the next cursor", async () => {
  const f = fixture();
  try {
    const initial = await readCodexEvents(f.request, f.options);
    appendFileSync(f.file, line(completion()).repeat(CODEX_EVENT_LIMITS.events + 1));
    const first = await readCodexEvents({ ...f.request, cursor: initial.cursor }, f.options);
    assert.equal(first.events.length, CODEX_EVENT_LIMITS.events);
    assert.ok(first.cursor.offset < statSync(f.file).size);
    const next = await readCodexEvents({ ...f.request, cursor: first.cursor }, f.options);
    assert.equal(next.events.length, 1);
    assert.equal(next.cursor.offset, statSync(f.file).size);
  } finally { f.close(); }
});

test("bounded metadata and unfinished lines fail closed instead of reading unbounded transcript text", async () => {
  const f = fixture();
  try {
    const initial = await readCodexEvents(f.request, f.options);
    appendFileSync(f.file, "x".repeat(CODEX_EVENT_LIMITS.chunkBytes));
    await assert.rejects(readCodexEvents({ ...f.request, cursor: initial.cursor }, f.options), /unavailable or unsupported/);
    writeFileSync(f.file, line(metadata({ base_instructions: "x".repeat(CODEX_EVENT_LIMITS.chunkBytes) })));
    await assert.rejects(readCodexEvents(f.request, f.options), /unavailable or unsupported/);
  } finally { f.close(); }
});

test("cursor and transport validators reject traversal, wrong-thread paths and added private fields", async () => {
  const f = fixture();
  try {
    const result = await readCodexEvents(f.request, f.options);
    assert.equal(validCodexEventCursor(result.cursor), true);
    assert.equal(validCodexEventRequest({ ...f.request, cursor: result.cursor }), true);
    assert.equal(validCodexEventCursor({ ...result.cursor, relativePath: "../auth.json" }), false);
    assert.equal(validCodexEventRequest({ ...f.request, threadId: parentId, cursor: result.cursor }), false);
    assert.equal(validCodexEventCursor({ ...result.cursor, offset: Number.MAX_SAFE_INTEGER }), false);
    assert.equal(validCodexEventResponse({ ...result, last_agent_message: "PRIVATE" }), false);
    assert.equal(validCodexEventResponse({ ...result, cursor: { ...result.cursor, prompt: "PRIVATE" } }), false);
    assert.equal(validCodexEventResponse({ ...result, events: [{ turnId, completedAt: 1791018062000, output: "PRIVATE" }] }), false);
  } finally { f.close(); }
});

test("duplicate exact UUID sources and symlinked sources cannot redirect a notification", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  try {
    const initial = await readCodexEvents(f.request, f.options);
    renameSync(f.file, f.file + ".actual");
    symlinkSync(f.file + ".actual", f.file);
    await assert.rejects(readCodexEvents({ ...f.request, cursor: initial.cursor }, f.options), /unavailable or unsupported/);
    await assert.rejects(readCodexEvents(f.request, f.options), /unavailable or unsupported/);
    rmSync(f.file); renameSync(f.file + ".actual", f.file);
    const secondDir = join(f.home, "sessions", "2026", "10", "04"); mkdirSync(secondDir);
    writeFileSync(join(secondDir, `rollout-2026-10-04T09-00-00-${threadId}.jsonl`), line(metadata()));
    await assert.rejects(readCodexEvents(f.request, f.options), /unavailable or unsupported/);
  } finally { f.close(); }
});

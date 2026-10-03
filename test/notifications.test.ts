import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexEventRequest, CodexEventResult } from "../apps/discord/codex-events.js";
import { CodexNotifications, NotificationMessage, NotificationStore, NotificationTarget, completionMessage } from "../apps/discord/notifications.js";

const threadId = "019a1111-1111-7111-8111-111111111111", turnId = "019a2222-2222-7222-8222-222222222222";
const cursor = { relativePath: `sessions/2026/10/03/rollout-2026-10-03T00-00-00-${threadId}.jsonl`, fileIdentity: "1:2:0", offset: 100 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-notify-"));
  const target: NotificationTarget = { guildId: "700000000000000001", channelId: "700000000000000002", machine: "local",
    terminalId: "tmux-0123456789", provider: "tmux", generation: "a".repeat(32), cwd: "/project" };
  let now = 1_000_000, current = target, events: CodexEventResult["events"] = [], captures = 0, reads = 0;
  const messages: NotificationMessage[] = [], store = new NotificationStore(join(root, "notifications.json"));
  const options = {
    now: () => now, wait: async () => {}, describe: async () => current,
    read: async (_target: NotificationTarget, request: CodexEventRequest): Promise<CodexEventResult> => {
      reads++;
      return { threadId, cwd: target.cwd, cursor: { ...cursor, offset: request.cursor ? request.cursor.offset + 100 : 1000 }, events: request.cursor ? events : [] };
    },
    capture: async (_target: NotificationTarget, lines: number) => { captures++; return Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n"); },
    send: async (_binding: unknown, message: NotificationMessage, _stillCurrent: () => boolean) => { messages.push(message); },
  };
  const service = new CodexNotifications(store, options);
  return { root, target, store, options, service, messages, counters: () => ({ captures, reads }),
    event: () => { events = [{ turnId, completedAt: now + 1 }]; now += 2; },
    events: (value: typeof events) => { events = value; }, change: (value: NotificationTarget) => { current = value; },
    time: (value: number) => { now = value; }, close() { service.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("native completion captures 60 lines once, persists cursor/dedup and keeps content out of state", async () => {
  const f = fixture();
  try {
    await f.service.enable(f.target.channelId, threadId); f.event();
    await f.service.pollOnce(); await f.service.pollOnce();
    assert.equal(f.messages.length, 1); assert.equal(f.counters().captures, 1);
    assert.match(f.messages[0].content, /Codex hoàn tất lượt trả lời/);
    assert.match(f.messages[0].content, /line 59/); assert.deepEqual(f.messages[0].allowedMentions, { parse: [] });
    const state = readFileSync(f.store.file, "utf8");
    assert.equal(state.includes("line 59"), false); assert.equal(state.includes("prompt"), false);
    assert.equal(f.store.get(f.target.channelId)?.claimedTurns.length, 1);
    assert.equal(f.store.get(f.target.channelId)?.cursor.offset, 1200);
  } finally { f.close(); }
});

test("long snapshots preserve all 60 redacted lines in an attachment and never activate mentions", () => {
  const output = Array.from({ length: 60 }, (_, i) => `${i}: @everyone PRIVATE_VALUE ${"x".repeat(80)}`).join("\n");
  const result = completionMessage(output, 60, ["PRIVATE_VALUE"]);
  assert.ok(result.content.length < 2000); assert.equal(result.files?.length, 1);
  const text = result.files![0].attachment.toString("utf8");
  assert.equal(text.split("\n").length, 60); assert.equal(text.includes("PRIVATE_VALUE"), false);
  assert.equal(text.includes("[REDACTED]"), true); assert.deepEqual(result.allowedMentions, { parse: [] });
  const huge = completionMessage("x".repeat(80_000) + "LAST_RESULT", 60);
  assert.ok(huge.files![0].attachment.length <= 64 * 1024); assert.ok(huge.files![0].attachment.toString().endsWith("LAST_RESULT"));
  assert.match(huge.content, /64 KiB/);
});

test("generation changes pause before capture, and disable during capture suppresses delivery", async () => {
  const f = fixture();
  try {
    await f.service.enable(f.target.channelId, threadId); f.event();
    f.change({ ...f.target, generation: "b".repeat(32) });
    await f.service.pollOnce();
    assert.equal(f.messages.length, 0); assert.equal(f.counters().captures, 0);
    assert.equal(f.store.get(f.target.channelId)?.state, "paused");
    f.change(f.target); await f.service.enable(f.target.channelId, threadId); f.event();
    f.options.capture = async () => { f.service.disable(f.target.channelId); return "must not leave host"; };
    await f.service.pollOnce(); assert.equal(f.messages.length, 0); assert.equal(f.store.get(f.target.channelId), undefined);
  } finally { f.close(); }
});

test("expired or pre-subscription completion events do not capture output", async () => {
  const f = fixture();
  try {
    await f.service.enable(f.target.channelId, threadId);
    f.events([{ turnId, completedAt: 999_999 }]); await f.service.pollOnce();
    f.time(1_200_001); f.events([{ turnId, completedAt: 1_000_001 }]); await f.service.pollOnce();
    assert.equal(f.counters().captures, 0); assert.equal(f.messages.length, 0);
  } finally { f.close(); }
});

test("an ambiguous Discord failure is claimed once and paused, never retried", async () => {
  const f = fixture(); let posts = 0;
  try {
    f.options.send = async () => { posts++; throw new Error("ambiguous network failure"); };
    await f.service.enable(f.target.channelId, threadId); f.event();
    await f.service.pollOnce(); await f.service.pollOnce();
    assert.equal(posts, 1); assert.equal(f.store.get(f.target.channelId)?.state, "paused");
    assert.equal(f.store.get(f.target.channelId)?.claimedTurns[0].turnId, turnId);
    assert.match(f.service.status(f.target.channelId), /will not be retried/);
  } finally { f.close(); }
});

test("restart and reconnect start at EOF and do not replay the disconnected interval", async () => {
  const f = fixture();
  try {
    await f.service.enable(f.target.channelId, threadId); f.event();
    const restarted = new CodexNotifications(f.store, f.options);
    await restarted.start(); assert.equal(f.store.get(f.target.channelId)?.cursor.offset, 1000);
    restarted.transportLost(); await restarted.pollOnce(); assert.equal(f.messages.length, 0);
    await restarted.resume(); await restarted.pollOnce(); assert.equal(f.messages.length, 0);
    restarted.close();
  } finally { f.close(); }
});

test("thread-changing input pauses notifications and a pending enable cannot undo off", async () => {
  const f = fixture();
  try {
    await f.service.enable(f.target.channelId, threadId);
    f.service.pauseForInput(f.target.terminalId, "/resume");
    assert.equal(f.store.get(f.target.channelId)?.state, "paused");
    let complete!: (result: CodexEventResult) => void;
    f.options.read = async () => new Promise<CodexEventResult>(resolve => { complete = resolve; });
    const pending = f.service.enable(f.target.channelId, threadId);
    while (!complete) await new Promise(resolve => setImmediate(resolve));
    f.service.disable(f.target.channelId);
    complete({ threadId, cwd: f.target.cwd, cursor, events: [] });
    await assert.rejects(pending, /changed/); assert.equal(f.store.get(f.target.channelId), undefined);
  } finally { f.close(); }
});

test("a stale poll cannot rewind the reconnect EOF cursor or deliver disconnected completions", async () => {
  const f = fixture(), started = deferred<void>(), result = deferred<CodexEventResult>();
  try {
    await f.service.enable(f.target.channelId, threadId);
    const readNormally = f.options.read;
    f.options.read = async (_target, request) => {
      if (request.cursor) { started.resolve(); return result.promise; }
      return { threadId, cwd: f.target.cwd, cursor: { ...cursor, offset: 7000 }, events: [] };
    };
    const pending = f.service.pollOnce(); await started.promise;
    f.service.transportLost(); await f.service.resume();
    assert.equal(f.store.get(f.target.channelId)?.cursor.offset, 7000);
    result.resolve({ threadId, cwd: f.target.cwd, cursor: { ...cursor, offset: 1100 }, events: [{ turnId, completedAt: 1_000_001 }] });
    await pending;
    assert.equal(f.store.get(f.target.channelId)?.cursor.offset, 7000);
    assert.equal(f.store.get(f.target.channelId)?.claimedTurns.length, 0);
    assert.equal(f.messages.length, 0); assert.equal(f.counters().captures, 0);
    f.options.read = readNormally; f.event(); await f.service.pollOnce();
    assert.equal(f.messages.length, 1); // Future completions still work after the old request drains.
  } finally { f.close(); }
});

test("a resume that finishes after transport loss cannot reopen delivery or change its cursor", async () => {
  const f = fixture(), started = deferred<void>(), result = deferred<CodexEventResult>();
  let reads = 0;
  try {
    await f.service.enable(f.target.channelId, threadId);
    f.options.read = async () => { reads++; started.resolve(); return result.promise; };
    const pending = f.service.resume(); await started.promise;
    f.service.transportLost();
    result.resolve({ threadId, cwd: f.target.cwd, cursor: { ...cursor, offset: 8000 }, events: [] }); await pending;
    const binding = f.store.get(f.target.channelId)!;
    assert.equal(binding.cursor.offset, 1000); assert.equal(f.service.isActive(binding), false);
    f.event(); await f.service.pollOnce();
    assert.equal(reads, 1); assert.equal(f.messages.length, 0);
  } finally { f.close(); }
});

test("overlapping resumes keep the newest EOF cursor even when the older read resolves last", async () => {
  const f = fixture(), firstStarted = deferred<void>(), secondStarted = deferred<void>();
  const older = deferred<CodexEventResult>(), newer = deferred<CodexEventResult>();
  let reads = 0;
  try {
    await f.service.enable(f.target.channelId, threadId);
    f.options.read = async () => {
      if (++reads === 1) { firstStarted.resolve(); return older.promise; }
      secondStarted.resolve(); return newer.promise;
    };
    const first = f.service.resume(); await firstStarted.promise;
    const second = f.service.resume(); await secondStarted.promise;
    newer.resolve({ threadId, cwd: f.target.cwd, cursor: { ...cursor, offset: 9000 }, events: [] }); await second;
    older.resolve({ threadId, cwd: f.target.cwd, cursor: { ...cursor, offset: 7000 }, events: [] }); await first;
    const binding = f.store.get(f.target.channelId)!;
    assert.equal(binding.cursor.offset, 9000); assert.equal(f.service.isActive(binding), true);
    assert.equal(f.messages.length, 0);
  } finally { f.close(); }
});

test("off during the final asynchronous enable check cannot resurrect a subscription", async () => {
  const f = fixture(), finalCheck = deferred<void>(), description = deferred<NotificationTarget>();
  let descriptions = 0;
  try {
    f.options.describe = async () => {
      if (++descriptions === 2) { finalCheck.resolve(); return description.promise; }
      return f.target;
    };
    const pending = f.service.enable(f.target.channelId, threadId); await finalCheck.promise;
    f.service.disable(f.target.channelId); description.resolve(f.target);
    await assert.rejects(pending, /changed/);
    assert.equal(f.store.get(f.target.channelId), undefined);
  } finally { f.close(); }
});

test("the final send guard suppresses a post that waited across disconnect and reconnect", async () => {
  const f = fixture(), sendStarted = deferred<void>(), releaseSend = deferred<void>();
  try {
    await f.service.enable(f.target.channelId, threadId); f.event();
    f.options.send = async (_binding, message, stillCurrent) => {
      sendStarted.resolve(); await releaseSend.promise;
      if (stillCurrent()) f.messages.push(message);
    };
    const pending = f.service.pollOnce(); await sendStarted.promise;
    f.service.transportLost(); await f.service.resume(); releaseSend.resolve(); await pending;
    assert.equal(f.messages.length, 0);
    assert.equal(f.store.get(f.target.channelId)?.claimedTurns.length, 1);
    assert.equal(f.service.isActive(f.store.get(f.target.channelId)!), true);
  } finally { f.close(); }
});

test("a timer state failure pauses delivery with a bounded log instead of an unhandled rejection", async t => {
  const f = fixture(), logs: string[] = [];
  t.mock.timers.enable({ apis: ["setInterval"] });
  // Node 22 reports MockTimers' experimental warning asynchronously. Flush it
  // before capturing application errors, whose count must remain exactly one.
  await new Promise(resolve => setImmediate(resolve));
  t.mock.method(console, "error", (...values: unknown[]) => { logs.push(values.join(" ")); });
  try {
    await f.service.enable(f.target.channelId, threadId); await f.service.start();
    const valid = readFileSync(f.store.file, "utf8");
    writeFileSync(f.store.file, "PRIVATE_INVALID_NOTIFICATION_STATE");
    t.mock.timers.tick(5000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logs.length, 1); assert.equal(logs[0].includes("PRIVATE"), false);
    writeFileSync(f.store.file, valid);
    assert.equal(f.service.isActive(f.store.get(f.target.channelId)!), false);
    assert.match(f.service.status(f.target.channelId), /Delivery is paused.*repair the state and restart the coordinator/);
    f.event(); await f.service.pollOnce(); assert.equal(f.messages.length, 0);
  } finally { f.close(); }
});

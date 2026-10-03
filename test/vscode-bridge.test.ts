import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { VscodeTerminal, vscodeInventory, vscodeSessions } from "../apps/discord/vscode.js";

const require = createRequire(import.meta.url);

function harness(options: { platform?: "win32" | "linux"; cwd?: string; remote?: boolean; creationCwd?: string; shellCwd?: string; autoDiscover?: boolean;
  legacySelection?: boolean; bootstrap?: { cwd?: string; expiresAt?: number; requestId?: string; label?: string } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vscode-bridge-test-"));
  if (options.autoDiscover) {
    mkdirSync(join(root, ".remote-operator"));
    writeFileSync(join(root, ".remote-operator", "vscode-bridge.json"), JSON.stringify({ version: 1, bridgeDirectory: root }));
  }
  if (options.bootstrap) writeFileSync(join(root, "create-vscode-attach-test.json"), JSON.stringify({
    requestId: "6".repeat(32), cwd: options.cwd, label: "Discord existing-tab test", expiresAt: Date.now() + 5000, ...options.bootstrap,
  }));
  if (options.legacySelection) writeFileSync(join(root, "share-current-vscode.json"), JSON.stringify({ pid: 1234, expiresAt: Date.now() + 5000 }));
  const actions = new Map<string, () => Promise<void>>();
  const disposables: { dispose(): void }[] = [];
  const sent: unknown[] = [];
  const created: any[] = [];
  const sentAt: number[] = [];
  let onSend: ((text: string) => void) | undefined;
  let clipboard = "original clipboard; never terminal output";
  let copyMode = "ok";
  let poll: () => Promise<void> = async () => {};
  let window: any;
  const terminal = { name: "selected", processId: Promise.resolve(1234), exitStatus: undefined,
    creationOptions: { cwd: options.creationCwd }, shellIntegration: options.shellCwd ? { cwd: { fsPath: options.shellCwd } } : undefined,
    sendText: (text: string, enter: boolean) => { sent.push({ text, enter }); sentAt.push(Date.now()); onSend?.(text); }, show: () => { window.activeTerminal = terminal; },
    dispose: () => { throw new Error("External terminal process must never be stopped by sharing"); } };
  const second = { name: "node", processId: Promise.resolve(5678), exitStatus: undefined,
    sendText: (text: string, enter: boolean) => sent.push({ text, enter }), show() {} };
  const other = { name: "other" };
  window = { terminals: [terminal, second], activeTerminal: terminal, showInformationMessage() {},
    showQuickPick: async (choices: any[]) => choices[0], onDidCloseTerminal: () => ({ dispose() {} }),
    createTerminal: (config: any) => {
      created.push(config);
      const disposable = { name: config.name, processId: Promise.resolve(9876), exitStatus: undefined, creationOptions: config,
        show: () => { window.activeTerminal = disposable; }, sendText: (text: string, enter: boolean) => sent.push({ text, enter }),
        dispose: () => { throw new Error("Attach test terminal stays outside the managed supervisor"); } };
      window.terminals.push(disposable); return disposable;
    } };
  const vscode = {
    window, workspace: { getConfiguration: () => ({ get: () => options.autoDiscover ? "" : root }), workspaceFolders: options.cwd ? [{ uri: { fsPath: options.cwd, authority: "ssh-remote+gpu" } }] : undefined },
    env: { remoteName: options.remote ? "ssh-remote" : undefined, clipboard: { readText: async () => clipboard, writeText: async (text: string) => { clipboard = text; } } },
    commands: {
      registerCommand: (name: string, fn: () => Promise<void>) => { actions.set(name, fn); return { dispose() {} }; },
      executeCommand: async (name: string) => {
        if (name.endsWith("copySelection")) {
          if (copyMode === "ok") clipboard = "actual selected terminal output";
          if (copyMode === "wrong-tab") { clipboard = "other terminal PRIVATE"; window.activeTerminal = other; }
        }
      },
    },
  };
  const module = { exports: {} as { activate: (context: unknown) => void } };
  runInNewContext(readFileSync(resolve(import.meta.dirname, "../../apps/vscode-bridge/extension.cjs"), "utf8"), {
    require: (name: string) => name === "vscode" ? vscode : name === "node:os" ? { ...require(name), platform: () => options.platform ?? process.platform, ...(options.autoDiscover ? { homedir: () => root } : {}) } : require(name), module, process: { env: {} },
    setInterval: (fn: () => Promise<void>) => { poll = fn; return 1; }, clearInterval() {}, setTimeout,
  });
  module.exports.activate({ subscriptions: disposables });
  return {
    root, terminal, sent, sentAt, created, window, actions, clipboard: () => clipboard, setCopyMode: (mode: string) => { copyMode = mode; }, setOnSend: (fn: (text: string) => void) => { onSend = fn; }, poll: () => poll(),
    reactivate: () => module.exports.activate({ subscriptions: disposables }),
    share: () => actions.get("remoteOperator.shareTerminal")!(),
    unshare: () => actions.get("remoteOperator.unshareTerminal")!(),
    request: async (action: string, id: string, text?: string, expiresAt = Date.now() + 5000, key?: string, generation?: string) => {
      const metadataFile = readdirSync(join(root, "vscode")).find(n => n.startsWith("instance-") && n.endsWith(".json"))!;
      const meta = JSON.parse(readFileSync(join(root, "vscode", metadataFile), "utf8"));
      const sessionId = meta.sessions[0]?.id ?? `vsc-${meta.instance}-12345678`;
      const base = join(root, "vscode", `${meta.instance}-${id}`);
      writeFileSync(base + ".request.json", JSON.stringify({ requestId: id, instance: meta.instance, sessionId, generation: generation ?? meta.sessions[0]?.generation, action, text, key, expiresAt }));
      await poll();
      try { return JSON.parse(readFileSync(base + ".response.json", "utf8")); } catch { return undefined; }
    },
    dispose: () => { disposables.forEach(d => d.dispose()); rmSync(root, { recursive: true, force: true }); },
  };
}

test("VS Code shares only selected terminals and literal input is not replayed", async () => {
  const h = harness();
  try {
    assert.deepEqual(vscodeSessions(h.root), []);
    assert.equal(vscodeInventory(h.root).length, 2);
    assert.deepEqual(vscodeInventory(h.root).map(s => s.label), ["selected", "node"]);
    assert.ok(vscodeInventory(h.root).every(s => !s.shared));
    const blockedId = "0".repeat(32);
    assert.equal((await h.request("send", blockedId, "must stay blocked")).ok, false);
    assert.deepEqual(h.sent, []);
    await h.share();
    assert.equal(vscodeSessions(h.root).length, 1);
    assert.deepEqual(vscodeInventory(h.root).map(s => s.shared), [true, false]);
    const id = "a".repeat(32);
    const reply = await h.request("send", id, "hello; $(not a bridge command)");
    assert.equal(reply.ok, true);
    assert.equal(reply.output, "Text sent to the selected VS Code terminal API; submit separately with key=enter");
    assert.deepEqual(h.sent, [{ text: "hello; $(not a bridge command)", enter: false }]);
    const keyReply = await h.request("key", "b".repeat(32), undefined, Date.now() + 5000, "enter");
    assert.equal(keyReply.ok, true);
    assert.equal(keyReply.output, "Key enter sent to the selected VS Code terminal API");
    assert.deepEqual(h.sent, [
      { text: "hello; $(not a bridge command)", enter: false },
      { text: "\r", enter: false },
    ]);
    await h.request("send", id, "duplicate");
    assert.equal(h.sent.length, 2);
    await h.request("send", "b".repeat(32), "stale", Date.now() - 1);
    assert.equal(h.sent.length, 2);
  } finally { h.dispose(); }
});

test("VS Code output returns copied terminal text and restores text clipboard", async () => {
  const h = harness();
  try {
    await h.share();
    const reply = await h.request("output", "c".repeat(32));
    assert.equal(reply.ok, true);
    assert.equal(reply.output, "actual selected terminal output");
    assert.equal(h.clipboard(), "original clipboard; never terminal output");
  } finally { h.dispose(); }
});

test("Shift + Left sends one modified-key sequence only to the shared generation and is never replayed", async () => {
  const h = harness();
  try {
    await h.share();
    const session = vscodeSessions(h.root)[0];
    const requestId = "4".repeat(32);
    const result = await h.request("key", requestId, undefined, Date.now() + 5000, "shift-left", session.generation);
    assert.equal(result.ok, true);
    assert.equal(result.output, "Key shift-left sent to the selected VS Code terminal API");
    assert.deepEqual(h.sent, [{ text: "\x1b[1;2D", enter: false }]);
    await h.request("key", requestId, undefined, Date.now() + 5000, "shift-left", session.generation);
    assert.equal(h.sent.length, 1);
    await h.unshare();
    await h.share();
    const stale = await h.request("key", "5".repeat(32), undefined, Date.now() + 5000, "shift-left", session.generation);
    assert.equal(stale.ok, false);
    assert.equal(h.sent.length, 1);
  } finally { h.dispose(); }
});

test("Shift + Left requires a loaded 0.1.7+ provider before IPC, while older providers retain the other keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "vscode-key-version-")), dir = join(root, "vscode");
  mkdirSync(dir);
  const instance = "a".repeat(16), id = `vsc-${instance}-12345678`, generation = "b".repeat(32);
  const metadata = join(dir, `instance-${instance}.json`);
  const describe = (providerVersion?: string) => writeFileSync(metadata, JSON.stringify({ instance, updatedAt: Date.now(), inputProtocol: "paced-submit-v1", providerVersion,
    sessions: [{ id, generation, label: "Existing tab", machine: "local", platform: "linux", alive: true, shared: true }] }));
  const terminal = new VscodeTerminal(root, id, generation);
  const acknowledge = async (key: Parameters<VscodeTerminal["pressKey"]>[0]) => {
    const pending = terminal.pressKey(key);
    const filename = readdirSync(dir).find(name => name.endsWith(".request.json"));
    assert.ok(filename, "Supported key should reach the selected provider");
    const request = JSON.parse(readFileSync(join(dir, filename), "utf8"));
    assert.equal(request.action, "key"); assert.equal(request.key, key);
    assert.equal(request.sessionId, id); assert.equal(request.generation, generation);
    writeFileSync(join(dir, filename.replace(".request.json", ".response.json")), JSON.stringify({ requestId: request.requestId, sessionId: id, generation, ok: true, output: "Key handed to API" }));
    await pending;
    assert.ok(!readdirSync(dir).some(name => name.endsWith(".request.json")));
  };
  try {
    for (const version of [undefined, "", "0.1.6", "0.1.7-alpha", "0.1.7-01", "0.01.7", "0.1.7oops", "v0.1.7"]) {
      describe(version);
      await assert.rejects(terminal.pressKey("shift-left"), /0\.1\.7.*Safely update.*share/);
      assert.deepEqual(readdirSync(dir), [metadata.split(/[\\/]/).at(-1)]);
    }
    for (const version of ["0.1.7", "0.1.7+build.2", "0.1.8-alpha", "0.1.10", "0.2.0", "1.0.0"]) {
      describe(version);
      await acknowledge("shift-left");
    }
    describe("0.1.6");
    for (const key of ["enter", "ctrl-c", "escape", "tab", "up", "down", "left", "right"] as const) await acknowledge(key);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed copy never substitutes pre-existing clipboard contents", async () => {
  const h = harness();
  try {
    await h.share(); h.setCopyMode("no-op");
    const reply = await h.request("output", "d".repeat(32));
    assert.equal(reply.ok, false);
    assert.equal(reply.output, undefined);
    assert.equal(h.clipboard(), "original clipboard; never terminal output");
  } finally { h.dispose(); }
});

test("switching terminal during copy refuses output; closing never redirects input", async () => {
  const h = harness();
  try {
    await h.share(); h.setCopyMode("wrong-tab");
    const reply = await h.request("output", "e".repeat(32));
    assert.equal(reply.ok, false);
    assert.equal(reply.output, undefined);
    h.window.terminals = [];
    assert.equal((await h.request("send", "f".repeat(32), "do not send")).ok, false);
    assert.equal(h.sent.length, 0);
  } finally { h.dispose(); }
});

test("stale VS Code metadata never authorizes a connection", () => {
  const root = mkdtempSync(join(tmpdir(), "vscode-stale-"));
  try {
    mkdirSync(join(root, "vscode"));
    const instance = "a".repeat(16);
    writeFileSync(join(root, "vscode", `instance-${instance}.json`), JSON.stringify({ instance, updatedAt: Date.now() - 20_000,
      sessions: [{ id: `vsc-${instance}-12345678`, label: "old", machine: "host", alive: true }] }));
    assert.deepEqual(vscodeSessions(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows cwd is derived per tab and remote tabs preserve their target path", async () => {
  const local = harness({ platform: "win32", cwd: "D:\\workspace", creationCwd: "D:\\created", shellCwd: "D:\\active" });
  const remote = harness({ platform: "win32", remote: true, cwd: "/datasets/workspace", shellCwd: "/datasets/active" });
  try {
    const session = vscodeInventory(local.root)[0];
    assert.equal(session.cwd, "D:\\active");
    assert.equal(session.cwdSource, "shellIntegration");
    assert.equal(session.platform, "win32");
    assert.equal(session.remote, false);
    assert.match(session.generation, /^[a-f0-9]{32}$/);
    assert.equal(session.inputProtocol, "paced-submit-v1");
    assert.equal(session.providerVersion, "0.1.7");
    const other = vscodeInventory(remote.root)[0];
    assert.equal(other.cwd, "/datasets/active");
    assert.equal(other.platform, "win32");
    assert.equal(other.remote, true);
    assert.equal(other.machine, "ssh-remote+gpu");
    await local.share();
    const shared = vscodeSessions(local.root)[0];
    assert.notEqual(shared.generation, session.generation);
  } finally { local.dispose(); remote.dispose(); }
});

test("creation cwd precedes the workspace fallback and its source remains visible", () => {
  const creation = harness({ platform: "linux", cwd: "/workspace", creationCwd: "/creation" });
  const fallback = harness({ platform: "linux", cwd: "/workspace" });
  try {
    assert.equal(vscodeInventory(creation.root)[0].cwd, "/creation");
    assert.equal(vscodeInventory(creation.root)[0].cwdSource, "creationOptions");
    assert.equal(vscodeInventory(fallback.root)[0].cwd, "/workspace");
    assert.equal(vscodeInventory(fallback.root)[0].cwdSource, "workspace");
  } finally { creation.dispose(); fallback.dispose(); }
});

test("submit uses one IPC request, paced text and one Enter, with no duplicate replay", async () => {
  const h = harness();
  try {
    await h.share();
    const session = vscodeSessions(h.root)[0];
    const terminal = new VscodeTerminal(h.root, session.id, session.generation, Date.now() + 5000);
    const task = terminal.send("Tiếng Việt, prompt đang chạy");
    const pending = readdirSync(join(h.root, "vscode")).filter(name => name.endsWith(".request.json"));
    assert.equal(pending.length, 1);
    const req = JSON.parse(readFileSync(join(h.root, "vscode", pending[0]), "utf8"));
    assert.equal(req.action, "submit");
    assert.equal(req.generation, session.generation);
    await h.poll(); await task;
    assert.deepEqual(h.sent, [{ text: "Tiếng Việt, prompt đang chạy", enter: false }, { text: "\r", enter: false }]);
    assert.ok(h.sentAt[1] - h.sentAt[0] >= 200);
    await h.request("submit", req.requestId, "must not replay");
    assert.equal(h.sent.length, 2);
  } finally { h.dispose(); }
});

test("unshare and immediate reshare revoke a pending submit and its pinned grant", async () => {
  const h = harness();
  try {
    await h.share();
    const before = vscodeSessions(h.root)[0];
    h.setOnSend(text => { if (text === "partial") void (async () => { await h.unshare(); await h.share(); })(); });
    const reply = await h.request("submit", "1".repeat(32), "partial");
    assert.equal(reply.ok, false);
    assert.deepEqual(h.sent, [{ text: "partial", enter: false }]);
    assert.notEqual(vscodeSessions(h.root)[0].generation, before.generation);
    await assert.rejects(new VscodeTerminal(h.root, before.id, before.generation).pressKey("enter"), /generation changed/);
    assert.equal((await h.request("key", "2".repeat(32), undefined, Date.now() + 5000, "enter", before.generation)).ok, false);
    assert.equal(h.sent.length, 1);
    // Sharing revocation never calls terminal.dispose(), which would kill work.
    assert.ok(h.window.terminals.includes(h.terminal));
  } finally { h.dispose(); }
});

test("expired paced submit and closed tab never deliver its trailing Enter", async () => {
  const expired = harness(), closed = harness();
  try {
    await expired.share();
    assert.equal((await expired.request("submit", "3".repeat(32), "partial", Date.now() + 100)).ok, false);
    assert.deepEqual(expired.sent, [{ text: "partial", enter: false }]);
    await closed.share();
    closed.setOnSend(() => { closed.window.terminals = []; });
    assert.equal((await closed.request("submit", "4".repeat(32), "partial")).ok, false);
    assert.deepEqual(closed.sent, [{ text: "partial", enter: false }]);
  } finally { expired.dispose(); closed.dispose(); }
});

test("legacy inventory has stable discovery generation but cannot submit with an old extension", async () => {
  const root = mkdtempSync(join(tmpdir(), "vscode-legacy-"));
  try {
    mkdirSync(join(root, "vscode"));
    const instance = "a".repeat(16), id = `vsc-${instance}-12345678`;
    writeFileSync(join(root, "vscode", `instance-${instance}.json`), JSON.stringify({ instance, updatedAt: Date.now(),
      sessions: [{ id, label: "old", machine: "host", cwd: root, alive: true }] }));
    const session = vscodeSessions(root)[0];
    assert.match(session.generation, /^[a-f0-9]{32}$/);
    assert.equal(vscodeSessions(root)[0].generation, session.generation);
    await assert.rejects(new VscodeTerminal(root, id).send("must not be delivered"), /0\.1\.6/);
    assert.ok(!readdirSync(join(root, "vscode")).some(name => name.endsWith(".request.json")));
    await assert.rejects(new VscodeTerminal(root, id, session.generation, Date.now() - 1).status(), /expired/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("blank configuration discovers the per-user agent locator without automatically sharing", async () => {
  const h = harness({ autoDiscover: true });
  try {
    assert.equal(vscodeInventory(h.root).length, 2);
    assert.equal(vscodeSessions(h.root).length, 0);
    await h.share();
    assert.equal(vscodeSessions(h.root).length, 1);
  } finally { h.dispose(); }
});

test("wrong instance, invalid generation and missing modern sharing flag fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "vscode-invalid-identity-"));
  try {
    mkdirSync(join(root, "vscode"));
    const instance = "a".repeat(16), file = join(root, "vscode", `instance-${instance}.json`);
    const base = { instance, platform: "linux", remote: false, inputProtocol: "paced-submit-v1", updatedAt: Date.now() };
    const session = { id: `vsc-${instance}-12345678`, label: "tab", machine: "host", cwd: "/project", alive: true, shared: true, generation: "b".repeat(32) };
    for (const patch of [{ id: `vsc-${"c".repeat(16)}-12345678` }, { generation: "invalid" }, { shared: undefined }]) {
      writeFileSync(file, JSON.stringify({ ...base, sessions: [{ ...session, ...patch }] }));
      assert.deepEqual(vscodeInventory(root), []);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("activation ignores deployment-only files and requires an explicit Share command", async () => {
  const cwd = process.platform === "win32" ? "D:\\attach-test" : "/attach-test";
  const h = harness({ cwd, bootstrap: {}, legacySelection: true });
  try {
    await new Promise<void>(done => setImmediate(done));
    assert.deepEqual(h.created, []);
    assert.deepEqual(vscodeSessions(h.root), []);
    assert.ok(readdirSync(h.root).includes("create-vscode-attach-test.json"));
    assert.ok(readdirSync(h.root).includes("share-current-vscode.json"));
    h.reactivate(); await new Promise<void>(done => setImmediate(done));
    assert.deepEqual(h.created, []);
    assert.deepEqual(vscodeSessions(h.root), []);
    await h.share();
    const sessions = vscodeSessions(h.root);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].pid, 1234);
    assert.equal(sessions[0].cwd, cwd);
    assert.deepEqual(h.created, []);
    assert.deepEqual(h.sent, []);
  } finally { h.dispose(); }
});

test("startup never creates or shares terminals from malformed flags or a remote window", async () => {
  const cwd = process.platform === "win32" ? "D:\\attach-test" : "/attach-test";
  for (const options of [
    { bootstrap: { cwd: process.platform === "win32" ? "D:\\other" : "/other" } },
    { bootstrap: { expiresAt: Date.now() - 1 } },
    { bootstrap: { expiresAt: Date.now() + 180_000 } },
    { bootstrap: { requestId: "invalid" } },
    { bootstrap: {}, remote: true },
    {},
  ]) {
    const h = harness({ cwd, ...options });
    try {
      await new Promise<void>(done => setImmediate(done));
      assert.deepEqual(h.created, []);
      assert.deepEqual(vscodeSessions(h.root), []);
    } finally { h.dispose(); }
  }
});

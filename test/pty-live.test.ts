import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensurePtySupervisor, PtyTerminal, readPtyClient } from "../apps/discord/pty-client.js";
import { HostExecutor } from "../apps/discord/hosts.js";
import { PTY_KEY_PROTOCOL } from "../apps/discord/pty-protocol.js";

test("real ConPTY: submit, capture, interrupt, reconnect, isolated stop, authorization", { skip: process.env.REMOTE_OPERATOR_LIVE_TESTS !== "1" || process.platform !== "win32", timeout: 60_000 }, async () => {
  const testRoot = resolve(".discord-bridge", "tests");
  mkdirSync(testRoot, { recursive: true });
  const state = mkdtempSync(join(testRoot, "pty-"));
  const cwd = join(state, "project with spaces Việt");
  mkdirSync(cwd);
  const client = await ensurePtySupervisor(state);
  const terminals: PtyTerminal[] = [];
  async function waitOutput(terminal: PtyTerminal, marker: string) {
    for (let i = 0; i < 80; i++) { const output = await terminal.output(100); if (output.includes(marker)) return output; await delay(100); }
    assert.fail(`Output did not contain ${marker}: ${await terminal.output(100)}`);
  }
  try {
    const first = await client.create(cwd, "local", "shell", "smoke:first"); terminals.push(first);
    assert.equal(first.record.keyProtocol, PTY_KEY_PROTOCOL);
    assert.equal((await client.request<{ keyProtocol: string }>("describe")).keyProtocol, PTY_KEY_PROTOCOL);
    assert.equal((await client.create(cwd, "local", "shell", "smoke:first")).record.id, first.record.id);
    await assert.rejects(client.create(state, "local", "shell", "smoke:first"), /different parameters/);
    // Result marker is composed, so terminal echo alone cannot pass this check.
    await first.send("[Console]::WriteLine(('EXECUTED_' + (21 * 2))); Add-Content -LiteralPath './once.txt' -Value 'one'");
    await waitOutput(first, "EXECUTED_42");
    for (let i = 0; i < 30 && !existsSync(join(cwd, "once.txt")); i++) await delay(100);
    assert.equal(readFileSync(join(cwd, "once.txt"), "utf8").trim(), "one");
    const second = await client.create(cwd, "local", "shell", "smoke:second"); terminals.push(second);
    const keyFixture = join(cwd, "keys.cjs");
    writeFileSync(keyFixture, "process.stdin.setRawMode(true); process.stdin.resume(); console.log('KEY_READY'); process.stdin.on('data', b => console.log('KEY_' + b.toString('hex')));");
    await second.send(`& '${process.execPath.replace(/'/g, "''")}' './keys.cjs'`);
    await waitOutput(second, "KEY_READY");
    const expectedKeys = { enter: "0d", "ctrl-c": "03", escape: "1b", tab: "09", up: "1b5b41", down: "1b5b42", left: "1b5b44", right: "1b5b43", "shift-left": "1b5b313b3244" } as const;
    for (const key of Object.keys(expectedKeys) as (keyof typeof expectedKeys)[]) {
      await second.pressKey(key);
      await waitOutput(second, `KEY_${expectedKeys[key]}`);
    }
    await first.send("while ($true) { Start-Sleep -Milliseconds 100 }");
    await delay(500);
    const diagnostic = await new HostExecutor({ id: "local", label: "Windows", kind: "local", cwd }, state).run("[Console]::Write(6 * 7)");
    assert.equal(diagnostic.stdout, "42");
    await first.interrupt();
    await delay(300);
    await first.send("[Console]::WriteLine(('INTERRUPTED_' + (3 * 7)))");
    await waitOutput(first, "INTERRUPTED_21");
    const reconnected = readPtyClient(state)!;
    assert.equal(reconnected.endpoint.pid, client.endpoint.pid);
    const recovered = (await reconnected.list()).find(record => record.id === first.record.id)!;
    const recoveredTerminal = new PtyTerminal(recovered, reconnected);
    await recoveredTerminal.send("[Console]::WriteLine(('RECONNECTED_' + (8 * 8)))");
    await waitOutput(recoveredTerminal, "RECONNECTED_64");
    await first.stop();
    assert.match(await first.status(), /alive=false/);
    await assert.rejects(first.send("'must not run'"), /exited/);
    await second.pressKey("tab");
    assert.match(await second.status(), /alive=true/);
    await waitOutput(second, "KEY_09");
    const response = await fetch(`http://127.0.0.1:${client.endpoint.port}/rpc`, { method: "POST", body: "{}" });
    assert.equal(response.status, 403);
    // Closed history must not exhaust the 32-live-terminal capacity.
    for (let i = 0; i < 33; i++) {
      const transient = await client.create(cwd, "local", "shell", `capacity:${i}`);
      terminals.push(transient);
      await transient.stop();
    }
    assert.match(await second.status(), /alive=true/);
  } finally {
    for (const terminal of terminals) { if ((await terminal.status()).includes("alive=true")) await terminal.stop(); }
    // This PID belongs to the supervisor started in this test's unique directory.
    process.kill(client.endpoint.pid);
    await delay(600);
    assert.ok(state.startsWith(testRoot + "\\"));
    rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

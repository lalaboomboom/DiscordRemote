import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmuxRunner } from "../apps/discord/core.js";
import { configuredHostById, hostForTerminal, probeTmux } from "../apps/discord/host-probe.js";
import { HostExecutor, HostResult } from "../apps/discord/hosts.js";

test("local preflight uses packaged tmux outside the diagnostic shell PATH", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "packaged-tmux-"));
  try {
    const binary = join(dir, "tmux");
    writeFileSync(binary, '#!/bin/sh\n[ "$5" = "-V" ] || exit 9\nprintf "tmux packaged-test\\n"\n', { mode: 0o700 });
    const executor = new HostExecutor({ id: "local", label: "Coordinator PC", kind: "local", cwd: dir }, dir);
    executor.run = async () => { throw new Error("Preflight looked for tmux in the shell PATH instead of using the selected provider"); };
    await probeTmux(executor, dir, tmuxRunner(binary, "test-probe"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SSH preflight checks tmux on the exact remote working directory", async () => {
  const executor = new HostExecutor({ id: "gpu", label: "GPU", kind: "ssh", cwd: "/", host: "gpu", user: "owner", port: 22 }, ".");
  const calls: unknown[][] = [];
  executor.run = async (...args) => {
    calls.push(args);
    return { stdout: "tmux 3.3\n", stderr: "", code: 0, signal: null, timedOut: false, durationMs: 1 };
  };
  await probeTmux(executor, "/datasets/project", async () => { throw new Error("Remote probe used local provider"); });
  assert.deepEqual(calls, [["tmux -V", 10_000, "/datasets/project"]]);
  const failed: HostResult = { stdout: "", stderr: "fixture-secret", code: 127, signal: null, timedOut: false, durationMs: 1 };
  executor.run = async () => failed;
  await assert.rejects(probeTmux(executor, "/datasets/project", async () => "", ["fixture-secret"]), error =>
    error instanceof Error && error.message.includes("tmux is not available") && !error.message.includes("fixture-secret"));
});

test("persisted machine IDs never resolve through renamed labels or SSH aliases", () => {
  const target = { id: "gpu", label: "remote", kind: "ssh" as const, cwd: "/", host: "gpu.internal", user: "owner", port: 22 };
  assert.equal(configuredHostById([target], "gpu"), target);
  for (const stale of ["remote", "gpu.internal", "missing"]) assert.throws(() => configuredHostById([target], stale), /not configured/);
});

test("managed terminal host actions cannot move to a replacement host sharing the old ID as a label", () => {
  const local = { id: "local", label: "Coordinator PC", kind: "local" as const, cwd: "/project" };
  const replacement = { id: "gpu-new", label: "gpu-old", kind: "ssh" as const, cwd: "/project", host: "gpu-old", user: "owner", port: 22 };
  const targets = [local, replacement];
  for (const provider of ["tmux", "conpty", undefined]) {
    assert.throws(() => hostForTerminal(targets, { machine: "gpu-old", provider }), /not configured/);
    assert.equal(hostForTerminal(targets, { machine: "gpu-new", provider }), replacement);
  }
  assert.equal(hostForTerminal(targets, { machine: "local", provider: "tmux" }), local);
  assert.throws(() => hostForTerminal(targets, { provider: "tmux" }), /not configured/);
  // Existing VS Code tabs retain their explicit compatibility metadata path.
  assert.equal(hostForTerminal(targets, { machine: "gpu-old", provider: "vscode" }), replacement);
  const duplicate = { ...replacement, id: "another-gpu" };
  assert.throws(() => hostForTerminal([...targets, duplicate], { machine: "gpu-old", provider: "vscode" }), /No configured host matches/);
});

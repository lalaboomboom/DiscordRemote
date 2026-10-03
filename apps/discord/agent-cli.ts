import { hostname } from "node:os";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { coordinatorUrl, AgentJob } from "./agent-hub.js";
import { AgentRuntime } from "./agent-runtime.js";
import { localPlatform, windowsShell } from "./platform.js";
import { publishVscodeBridgeDirectory } from "./vscode-locator.js";

interface Enrollment { url: string; machine: string; token: string; guildId: string; ownerId: string; cwd: string }
const state = resolve(process.env.REMOTE_OPERATOR_AGENT_STATE || ".remote-operator/agent");
const file = resolve(state, "enrollment.json");
function protect(value: string, decrypt = false): string {
  if (process.platform !== "win32") return value;
  const op = decrypt
    ? "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"
    : "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
  const result = spawnSync(windowsShell(), ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); [Console]::Write(${op})`], { input: value, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.status !== 0 || result.error) throw new Error("OS credential protection failed.");
  return result.stdout;
}
async function post<T>(url: string, path: string, body: unknown, token?: string): Promise<T> {
  const response = await fetch(new URL(path, coordinatorUrl(url)), { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!response.ok) throw new Error(`Coordinator rejected request (${response.status}).`);
  const text = await response.text(); if (text.length > 6 * 1024 * 1024) throw new Error("Oversized coordinator response.");
  return (JSON.parse(text) as { result: T }).result;
}
async function main() {
  const action = process.argv[2];
  if (action === "pair") {
    if (existsSync(file)) throw new Error("Already enrolled. Revoke the old enrollment and preserve its state before pairing again.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const url = coordinatorUrl(await rl.question("Coordinator HTTPS URL (or loopback SSH tunnel): ")).origin;
      const code = (await rl.question("One-time pairing code from /machine pair: ")).trim();
      const guildId = (await rl.question("Expected Discord guild ID: ")).trim();
      const ownerId = (await rl.question("Expected owner user ID: ")).trim();
      if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(ownerId)) throw new Error("Invalid scope IDs.");
      const cwd = resolve(await rl.question("Default project folder (blank = current directory): ") || process.cwd());
      console.log(`Authorize ${url} to control this machine for guild ${guildId}, owner ${ownerId}.`);
      if ((await rl.question("Type PAIR to continue: ")).trim() !== "PAIR") throw new Error("Enrollment cancelled.");
      const result = await post<Omit<Enrollment, "url" | "cwd">>(url, "/pair", { code, label: hostname(), platform: localPlatform(), cwd });
      if (result.guildId !== guildId || result.ownerId !== ownerId || !/^agent-[a-f0-9]{16}$/.test(result.machine) || !/^[a-f0-9]{64}$/.test(result.token)) throw new Error("Coordinator scope does not match; enrollment was not installed.");
      mkdirSync(state, { recursive: true, mode: 0o700 });
      writeFileSync(file, protect(JSON.stringify({ ...result, url, cwd })), { flag: "wx", mode: 0o600 });
      console.log(`Paired ${result.machine}. Start with npm run agent:start. Credentials stored locally; no Discord token is needed.`);
    } finally { rl.close(); }
    return;
  }
  if (action !== "start") throw new Error("Use pair or start.");
  const enrollment = JSON.parse(protect(readFileSync(file, "utf8"), true)) as Enrollment;
  coordinatorUrl(enrollment.url);
  if (!/^[a-f0-9]{64}$/.test(enrollment.token)) throw new Error("Invalid enrollment credential.");
  const runtime = await AgentRuntime.start(enrollment.machine, state, enrollment.cwd);
  publishVscodeBridgeDirectory(process.env.REMOTE_OPERATOR_VSCODE_BRIDGE_DIRECTORY || state);
  let stopped = false, active = 0, reportedOffline = false;
  process.once("SIGINT", () => { stopped = true; }); process.once("SIGTERM", () => { stopped = true; });
  console.log(`${new Date().toISOString()} Agent ${enrollment.machine} started. Stopping this client leaves managed terminals running.`);
  while (!stopped) {
    let phase = "snapshot";
    try {
      const snapshot = await runtime.snapshot();
      phase = "poll";
      const jobs = await post<AgentJob[]>(enrollment.url, "/poll", { machine: enrollment.machine, snapshot }, enrollment.token);
      if (!Array.isArray(jobs) || jobs.length > 64) throw new Error("Invalid coordinator jobs.");
      if (reportedOffline) console.log(`${new Date().toISOString()} Coordinator reconnected; input was not replayed.`); reportedOffline = false;
      for (const job of jobs) {
        if (active >= 32) continue; // Dropped work expires, never replayed.
        active++;
        void (async () => {
          let result: unknown, error: string | undefined;
          try { result = await runtime.dispatch(job); } catch { error = "Agent operation failed; inspect the machine before retrying. No input replay."; }
          try { await post(enrollment.url, "/result", { machine: enrollment.machine, id: job.id, result, error }, enrollment.token); }
          catch { console.error(`${new Date().toISOString()} Action response lost; it will not be replayed.`); }
          finally { active--; }
        })();
      }
    } catch (error) {
      const reason = error instanceof Error && /^Coordinator rejected request \(\d+\)\.$/.test(error.message) ? error.message : error instanceof Error ? error.name : "Error";
      if (!reportedOffline) console.error(`${new Date().toISOString()} Coordinator unavailable/revoked (${phase}: ${reason}). Terminals remain; no commands replayed.`);
      reportedOffline = true;
    }
    await delay(reportedOffline ? 3000 : 500);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Agent failed."); process.exitCode = 1; });

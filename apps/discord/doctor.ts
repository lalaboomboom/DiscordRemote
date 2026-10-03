import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentHub, AgentPresence } from "./agent-hub.js";
import { configFromEnv, redact, tmuxRunner } from "./core.js";
import { HostExecutor, hostPlatform, hostTargetConnection, loadHostTargets } from "./hosts.js";
import { probeTmux } from "./host-probe.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const state = resolve(root, ".discord-bridge");

/** Read-only connection check; never starts another bot or submits terminal input. */
async function main(): Promise<void> {
  const envFile = resolve(root, ".env.discord");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = configFromEnv(process.env);
  const targets = loadHostTargets(root);
  const secrets = [config.token, ...targets.map(target => target.password ?? "")];
  let heartbeat: { pid?: number; state?: string; updatedAt?: number; runtimeRoot?: string; agents?: AgentPresence[] } = {};
  const healthFile = resolve(state, "health.json");
  if (existsSync(healthFile)) heartbeat = JSON.parse(readFileSync(healthFile, "utf8"));
  const now = Date.now();
  const age = now - (heartbeat.updatedAt ?? 0);
  const fresh = age >= 0 && age < 15_000;
  console.log(`Coordinator: ${fresh ? heartbeat.state : "no current heartbeat"}${heartbeat.pid ? ` (PID ${heartbeat.pid})` : ""}`);
  if (heartbeat.runtimeRoot) console.log(`Active runtime: ${heartbeat.runtimeRoot}`);
  if (!fresh || heartbeat.state !== "ready") process.exitCode = 1;

  const binary = process.env.TMUX_BIN || (existsSync(resolve(root, ".local-tools/usr/bin/tmux")) ? resolve(root, ".local-tools/usr/bin/tmux") : "tmux");
  const localRun = tmuxRunner(binary, "discord-bridge");
  const rows = await Promise.all(targets.map(async target => {
    try {
      const executor = new HostExecutor(target, root);
      const result = await executor.run(hostPlatform(target) === "win32" ? "(Get-Location).Path" : "pwd", 10_000, target.cwd);
      if (result.code !== 0 || result.timedOut) throw new Error(`working directory/connection probe failed (exit=${result.code}, timeout=${result.timedOut})`);
      if (hostPlatform(target) === "linux") await probeTmux(executor, target.cwd, localRun, secrets);
      return `OK ${target.id}: ${hostTargetConnection(target)}`;
    } catch (error) {
      process.exitCode = 1;
      return `FAIL ${target.id}: ${redact(error instanceof Error ? error.message : "connection probe failed", secrets).slice(0, 500)}`;
    }
  }));
  for (const row of rows) console.log(row);

  // Host probes can take seconds; use the current heartbeat for agent status.
  if (existsSync(healthFile)) heartbeat = JSON.parse(readFileSync(healthFile, "utf8"));
  const agentNow = Date.now();
  const agentAge = agentNow - (heartbeat.updatedAt ?? 0);
  const agentFresh = agentAge >= 0 && agentAge < 15_000;
  const hub = new AgentHub(resolve(state, "agents.json"), config.guildId, config.ownerId);
  for (const machine of hub.list()) {
    const presence = heartbeat.agents?.find(agent => agent.id === machine.id);
    const lastSeen = presence?.lastSeen;
    const online = agentFresh && typeof lastSeen === "number" && agentNow >= lastSeen && agentNow - lastSeen < 8000;
    const observed = agentFresh && Array.isArray(heartbeat.agents);
    const status = online ? "online" : observed ? "offline" : "unknown (runtime has no current agent heartbeat)";
    console.log(`${online ? "OK" : "CHECK"} ${machine.label} [${machine.id}]: ${status} · ${machine.platform} · ${machine.cwd}`);
    if (!online) {
      console.log("  On this machine, keep agent:tunnel and agent:start running under the enrolled user. Tailscale online alone does not connect the agent.");
      process.exitCode = 1;
    } else {
      console.log(`  ${presence!.terminalCount} managed terminal(s) reported; last poll ${Math.round((agentNow - lastSeen!) / 1000)}s ago.`);
      if (presence!.vscodeCount !== undefined) console.log(`  VS Code: ${presence!.sharedVscodeCount} shared / ${presence!.vscodeCount} discovered tab(s).`);
    }
  }
  console.log("Discord operator: /machine list. Terminal channel: /status, /output; ordinary messages submit input.");
}

main().catch(() => { console.error("Connection check failed; inspect local configuration and permissions. Credentials are not printed."); process.exitCode = 1; });

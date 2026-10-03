import { execFile, execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { tmuxRunner } from "./core.js";
import { windowsEnvironment, windowsShell } from "./platform.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const state = resolve(root, ".discord-bridge");
const entry = resolve(root, "dist/apps/discord/main.js");
const execFileAsync = promisify(execFile);

function tmuxBinary() {
  const local = resolve(root, ".local-tools/usr/bin/tmux");
  return process.env.TMUX_BIN || (existsSync(local) ? local : "tmux");
}

function livePid(): number | undefined {
  const file = resolve(state, "bridge.pid");
  if (!existsSync(file)) return;
  const pid = Number(readFileSync(file, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid bridge.pid");
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
  if (process.platform === "win32") {
    const raw = execFileSync(windowsShell(), ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
    if (!raw.trim()) return;
    const info = JSON.parse(raw);
    const args = [...String(info.CommandLine).matchAll(/"([^"\r\n]*)"|([^\s"]+)/g)].map(match => match[1] ?? match[2]);
    if (String(info.ExecutablePath).toLowerCase() !== process.execPath.toLowerCase() || args.length !== 2 || resolve(args[1]).toLowerCase() !== entry.toLowerCase()) throw new Error("PID does not belong to this bridge; refusing to signal it.");
    return pid;
  }
  const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  const cwd = realpathSync(`/proc/${pid}/cwd`);
  if (!argv[1] || resolve(cwd, argv[1]) !== entry || cwd !== root.replace(/\/$/, "")) {
    throw new Error("PID does not belong to this bridge; refusing to signal it.");
  }
  return pid;
}

function health(pid: number): string {
  try {
    const value = JSON.parse(readFileSync(resolve(state, "health.json"), "utf8"));
    return value.pid === pid && Date.now() - value.updatedAt < 15_000 ? value.state : "running; readiness unknown";
  } catch { return "running; readiness unknown"; }
}

async function main() {
  const action = process.argv[2] ?? "status";
  const pid = livePid();
  if (action === "status") { console.log(pid ? `Bridge PID ${pid}: ${health(pid)}` : "Bridge stopped."); return; }
  if (action === "stop") {
    if (!pid) { console.log("Bridge already stopped."); return; }
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 50; i++) { if (!livePid()) { console.log("Bridge stopped. Terminal sessions are unchanged."); return; } await setTimeout(100); }
    throw new Error("Bridge is still stopping; not force-killing it.");
  }
  if (action !== "start") throw new Error("Use start, stop or status.");
  if (pid) { console.log(`Bridge already running: PID ${pid}, ${health(pid)}`); return; }
  if (process.platform === "win32") {
    mkdirSync(state, { recursive: true });
    const log = openSync(resolve(state, "bridge.log"), "a");
    // The bot needs its own deployment configuration. Only terminal/diagnostic
    // children use the restricted environment; do not strip coordinator settings.
    const child = spawn(process.execPath, [entry], { cwd: root, detached: true, windowsHide: true, stdio: ["ignore", log, log], env: process.env });
    closeSync(log);
    const spawned = await new Promise<number>((done, reject) => { child.once("error", reject); child.once("spawn", () => done(child.pid!)); });
    child.unref();
    for (let i = 0; i < 100; i++) {
      await setTimeout(200);
      if (health(spawned) === "ready") { console.log(`Bridge ready: PID ${spawned}. Log: .discord-bridge/bridge.log`); return; }
      try { process.kill(spawned, 0); } catch { throw new Error("Bridge exited; inspect .discord-bridge/bridge.log."); }
    }
    console.log(`Bridge PID ${spawned}: ${health(spawned)}. Inspect .discord-bridge/bridge.log.`);
    return;
  }
  const binary = tmuxBinary();
  const deploymentEnv = Object.entries(process.env).filter(([key, value]) => value !== undefined && /^REMOTE_OPERATOR_(AGENT_(PORT|BIND|URL)|TLS_(KEY|CERT))$/.test(key));
  const run = tmuxRunner(binary, "discord-bridge");
  const sessions = await run(["list-sessions", "-F", "#{session_name}"]).catch(() => "");
  if (sessions.split("\n").includes("discord-bot")) {
    throw new Error("discord-bot tmux session already exists but has no healthy bridge PID; inspect it before restarting.");
  }
  // Keep the bot in a dedicated, named tmux session so closing Codex or its
  // tool terminal cannot reap the Gateway connection. No credentials are put
  // in the tmux command: main.ts loads the gitignored .env.discord itself.
  await execFileAsync(binary, ["-L", "discord-bridge", "-f", "/dev/null", "new-session", "-d",
    ...deploymentEnv.flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "-s", "discord-bot", "-c", root, process.execPath, entry], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME, USER: process.env.USER,
      LANG: "C.UTF-8", TERM: "xterm-256color", ...(binary.includes("/") ? { LD_LIBRARY_PATH: resolve(dirname(binary), "../lib/x86_64-linux-gnu") } : {}) },
    timeout: 5000, maxBuffer: 2048,
  });
  for (let i = 0; i < 100; i++) {
    await setTimeout(100);
    const started = livePid();
    if (started && health(started) === "ready") { console.log(`Bridge ready: PID ${started}. Log: .discord-bridge/bridge.log`); return; }
  }
  const started = livePid();
  if (started) console.log(`Bridge PID ${started}: ${health(started)}. Check .discord-bridge/bridge.log.`);
  else throw new Error("Bridge did not start; inspect .discord-bridge/bridge.log.");
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Bridge control failed"); process.exitCode = 1; });

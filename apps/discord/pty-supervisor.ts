/** Independent owner of Windows PTYs. Bot exits never dispose these terminals. */
import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, IPty } from "node-pty";
import xterm from "@xterm/headless";
import { TERMINAL_KEYS, TerminalKey } from "./core.js";
import { requireWorkingDirectory, windowsEnvironment, windowsShell } from "./platform.js";
import { PtyRecord, SupervisorEndpoint, PTY_KEY_PROTOCOL } from "./pty-protocol.js";
import { PTY_INPUT_VERSION, submitPtyInput } from "./pty-input.js";

const state = resolve(process.argv[2] ?? fileURLToPath(new URL("../../../.discord-bridge", import.meta.url)));
const endpointFile = resolve(state, "pty-supervisor.json");
const lock = resolve(state, "pty-supervisor.pid");
const generation = randomBytes(16).toString("hex");
const token = randomBytes(32).toString("hex");
type Entry = { record: PtyRecord; pty: IPty; screen: InstanceType<typeof xterm.Terminal>; queue: Promise<unknown> };
const entries = new Map<string, Entry>();
const creations = new Map<string, string>();
const keys: Record<TerminalKey, string> = { enter: "\r", "ctrl-c": "\x03", escape: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", "shift-left": "\x1b[1;2D" };

function acquireLock() {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid supervisor lock.");
    try { process.kill(pid, 0); throw new Error("Supervisor already running or PID reused; inspect before restarting."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    unlinkSync(lock);
  }
  writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  process.on("exit", () => {
    try { if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock); } catch {}
  });
}

async function operation(body: Record<string, unknown>): Promise<unknown> {
  if (body.generation !== generation) throw new Error("Stale supervisor generation; request was not dispatched.");
  if (body.op === "list") return [...entries.values()].map(entry => entry.record);
  if (body.op === "describe") return { platform: "win32", provider: "conpty", inputVersion: PTY_INPUT_VERSION, keyProtocol: PTY_KEY_PROTOCOL, shell: windowsShell(), generation, capabilities: ["submit", "keys", "capture", "stop", "survive-bot-restart"] };
  if (body.op === "create") {
    const { requestId, cwd, machine, kind } = body;
    if (typeof requestId !== "string" || !/^[A-Za-z0-9:_-]{1,160}$/.test(requestId)) throw new Error("Invalid creation identity.");
    if (typeof cwd !== "string" || typeof machine !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(machine) || (kind !== "shell" && kind !== "codex")) throw new Error("Invalid creation request.");
    const prior = creations.get(requestId);
    if (prior) {
      const record = entries.get(prior)?.record;
      if (!record) throw new Error("Previously created terminal was closed and retired; it will not be recreated.");
      if (record.cwd !== cwd || record.machine !== machine || record.kind !== kind) throw new Error("Creation identity reused with different parameters.");
      return record;
    }
    requireWorkingDirectory(cwd, "win32");
    if (!statSync(cwd).isDirectory()) throw new Error("Working directory does not exist.");
    if ([...entries.values()].filter(entry => entry.record.alive).length >= 32) throw new Error("Supervisor limit reached (32 live terminals). Stop a terminal before creating another.");
    // Bound retained screens without counting closed history against live capacity.
    if (entries.size >= 256) {
      for (const [id, entry] of entries) {
        if (!entry.record.alive) { entry.screen.dispose(); entries.delete(id); }
        if (entries.size < 256) break;
      }
    }
    const claims = resolve(state, "pty-claims");
    mkdirSync(claims, { recursive: true, mode: 0o700 });
    // Claim before spawn. After supervisor loss, never recreate an ambiguous request.
    const claim = resolve(claims, createHash("sha256").update(requestId).digest("hex"));
    try { writeFileSync(claim, generation, { flag: "wx", mode: 0o600 }); }
    catch { throw new Error("Creation was previously claimed; outcome unknown. Create a new terminal channel after inspecting the old one."); }
    const screen = new xterm.Terminal({ cols: 140, rows: 40, scrollback: 1000, allowProposedApi: true });
    const shell = windowsShell();
    const args = kind === "codex" ? ["-NoLogo", "-NoProfile", "-Command", "codex"] : ["-NoLogo", "-NoProfile"];
    const pty = spawn(shell, args, { name: "xterm-256color", cols: 140, rows: 40, cwd, env: windowsEnvironment(process.env) as Record<string, string>, useConpty: true });
    const record: PtyRecord = { id: `pty-${randomBytes(16).toString("hex")}`, label: "terminal", machine, cwd, kind, provider: "conpty", generation, createdAt: Date.now(), alive: true, keyProtocol: PTY_KEY_PROTOCOL };
    const entry: Entry = { record, pty, screen, queue: Promise.resolve() };
    entries.set(record.id, entry);
    creations.set(requestId, record.id);
    let queuedCharacters = 0;
    pty.onData(data => {
      // Bound pending parser writes as well as retained scrollback.
      if (queuedCharacters + data.length > 1024 * 1024) return;
      queuedCharacters += data.length;
      screen.write(data, () => { queuedCharacters -= data.length; });
    });
    pty.onExit(() => { record.alive = false; });
    return record;
  }
  if (typeof body.id !== "string" || !entries.has(body.id)) throw new Error("Unknown or stale terminal; it will not be recreated.");
  const entry = entries.get(body.id)!;
  const task = entry.queue.then(async () => {
    if (Number(body.deadline) < Date.now()) throw new Error("Request expired in terminal queue; not dispatched.");
    if (body.op === "status") return `provider=conpty input=${PTY_INPUT_VERSION} keys=${PTY_KEY_PROTOCOL} generation=${generation} pid=${entry.pty.pid} alive=${entry.record.alive} dead=${entry.record.alive ? 0 : 1}`;
    if (body.op === "output") {
      const lines = body.lines;
      if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > 100) throw new Error("Invalid line count.");
      await new Promise<void>(done => entry.screen.write("", done));
      const buffer = entry.screen.buffer.active;
      const result: string[] = [];
      for (let i = Math.max(0, buffer.length - 200); i < buffer.length; i++) result.push(buffer.getLine(i)?.translateToString(true) ?? "");
      return result.join("\n").trimEnd().split("\n").slice(-lines).join("\n");
    }
    if (!entry.record.alive) throw new Error("Terminal has exited.");
    if (body.op === "send") {
      if (typeof body.text !== "string") throw new Error("Invalid input.");
      await submitPtyInput(body.text, text => entry.pty.write(text), () => entry.record.alive, Number(body.deadline));
    } else if (body.op === "key") {
      if (!TERMINAL_KEYS.includes(body.key as TerminalKey)) throw new Error("Unsupported key.");
      entry.pty.write(keys[body.key as TerminalKey]);
    } else if (body.op === "stop") {
      entry.pty.kill();
      entry.record.alive = false;
    } else throw new Error("Unsupported supervisor operation.");
    return null;
  });
  entry.queue = task.catch(() => {});
  return task;
}

async function main() {
  if (process.platform !== "win32") throw new Error("ConPTY supervisor requires Windows.");
  acquireLock();
  const seen = new Map<string, number>();
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.method !== "POST" || req.url !== "/rpc" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403).end(); return; }
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 16_384) throw new Error("Request too large."); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || typeof body.actionId !== "string" || !/^[a-f0-9]{32}$/.test(body.actionId) || !Number.isSafeInteger(body.deadline) || body.deadline < Date.now() || body.deadline > Date.now() + 60_000) throw new Error("Invalid or expired request.");
      if (seen.has(body.actionId)) throw new Error("Duplicate request; not replayed.");
      for (const [id, deadline] of seen) { if (deadline < Date.now()) seen.delete(id); }
      if (seen.size >= 100_000) throw new Error("Request capacity reached; maintenance required.");
      seen.set(body.actionId, body.deadline);
      const result = await operation(body);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Supervisor operation failed." }));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No supervisor endpoint.");
  const endpoint: SupervisorEndpoint = { version: 1, port: address.port, token, generation, pid: process.pid };
  writeFileSync(endpointFile + ".tmp", JSON.stringify(endpoint), { mode: 0o600 });
  renameSync(endpointFile + ".tmp", endpointFile);
  console.log(`ConPTY supervisor ready, PID ${process.pid}.`);
}

main().catch(() => { console.error("ConPTY supervisor startup failed; inspect its lock and native dependencies."); process.exitCode = 1; });

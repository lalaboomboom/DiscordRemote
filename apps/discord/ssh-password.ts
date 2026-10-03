import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { timingSafeEqual, createHash } from "node:crypto";
import ssh2 from "ssh2";
import { StringDecoder } from "node:string_decoder";
import { isIP } from "node:net";
const { Client } = ssh2;
import type { HostResult, HostTarget } from "./hosts.js";
import { SessionError } from "./errors.js";

const exec = promisify(execFile);
export type PasswordSshMode = "openssh" | "direct-pinned";

function pinnedConfig(target: HostTarget, host: string) {
  if (!target.hostKeySha256 || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(target.hostKeySha256)) throw new SessionError("Invalid SSH fingerprint.");
  return { host, port: target.port!, username: target.user!, password: target.password!, readyTimeout: 10_000,
    hostVerifier: (key: Buffer) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}` === target.hostKeySha256,
  };
}

/** Use OpenSSH's config and known_hosts matcher, including hashed hostnames.
 * Never learn a key from the connection being authenticated. A deliberately
 * selected literal-IP route with independently pinned trust needs no aliases. */
export async function passwordSshConfig(target: HostTarget, mode: PasswordSshMode = "openssh", deadline?: number) {
  const remainingTimeout = () => {
    if (deadline === undefined) return 5000;
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new SessionError("SSH read deadline has expired.");
    return Math.min(5000, deadline - Date.now());
  };
  remainingTimeout();
  if (mode === "direct-pinned") {
    if (target.kind !== "ssh" || !isIP(target.host ?? "") || !target.user || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(target.user)
      || !target.password || !Number.isInteger(target.port) || target.port! < 1 || target.port! > 65535) {
      throw new SessionError("Direct pinned SSH requires a literal IP, explicit user/port/password and a verified SHA256 fingerprint; aliases require OpenSSH configuration.");
    }
    return pinnedConfig(target, target.host!);
  }
  if (mode !== "openssh") throw new SessionError("Invalid SSH configuration mode.");
  const { stdout } = await exec("ssh", ["-G", "-p", String(target.port), "-l", target.user!, target.host!], { timeout: remainingTimeout(), windowsHide: true, maxBuffer: 128 * 1024 });
  const config = new Map(stdout.split(/\r?\n/).map(line => { const at = line.indexOf(" "); return [line.slice(0, at), line.slice(at + 1)]; }));
  if ((config.get("proxycommand") && config.get("proxycommand") !== "none") || (config.get("proxyjump") && config.get("proxyjump") !== "none")) throw new SessionError("Password SSH with ProxyCommand/ProxyJump is not supported; use native key authentication for that profile.");
  const host = config.get("hostname") || target.host!;
  if (target.hostKeySha256) return pinnedConfig(target, host);
  const alias = config.get("hostkeyalias") || host;
  const lookup = target.port === 22 ? alias : `[${alias}]:${target.port}`;
  const files = [...(config.get("userknownhostsfile") ?? "~/.ssh/known_hosts").matchAll(/"([^"]+)"|(\S+)/g), ...(config.get("globalknownhostsfile") ?? "").matchAll(/"([^"]+)"|(\S+)/g)].map(m => (m[1] || m[2]).replace(/^~(?=[/\\])/, homedir()));
  const keys: Buffer[] = [], revoked: Buffer[] = [];
  for (const file of files) {
    remainingTimeout();
    if (!existsSync(file)) continue;
    const found = await exec("ssh-keygen", ["-F", lookup, "-f", resolve(file)], { timeout: remainingTimeout(), windowsHide: true, maxBuffer: 256 * 1024 }).catch(error => { if (error.code === 1) return { stdout: "" }; throw error; });
    for (const line of found.stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (!parts[0] || parts[0].startsWith("#")) continue;
      if (parts[0] === "@cert-authority") continue;
      const isRevoked = parts[0] === "@revoked";
      if (parts[0].startsWith("@") && !isRevoked) continue;
      const key = Buffer.from(parts[isRevoked ? 3 : 2] ?? "", "base64");
      if (key.length) (isRevoked ? revoked : keys).push(key);
    }
  }
  if (!keys.length) throw new SessionError("SSH host key is not trusted in OpenSSH known_hosts. Verify its fingerprint and establish trust manually before connecting.");
  const equal = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
  return { host, port: target.port!, username: target.user!, password: target.password!, readyTimeout: 10_000,
    hostVerifier: (key: Buffer) => !revoked.some(k => equal(k, key)) && keys.some(k => equal(k, key)),
  };
}

export async function runPasswordSsh(target: HostTarget, command: string, timeoutMs: number, input?: string | Buffer, mode: PasswordSshMode = "openssh", deadline?: number): Promise<HostResult> {
  if (deadline !== undefined && (!Number.isSafeInteger(deadline) || deadline <= Date.now())) throw new SessionError("SSH read deadline has expired.");
  const config = await passwordSshConfig(target, mode, deadline);
  if (deadline !== undefined && deadline <= Date.now()) throw new SessionError("SSH read deadline has expired.");
  return new Promise(resolveResult => {
    const started = Date.now(), conn = new Client();
    const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
    let stdout = "", stderr = "", size = 0, finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, timedOut = false) => {
      if (finished) return;
      finished = true; clearTimeout(timer); conn.destroy();
      resolveResult({ stdout: stdout + stdoutDecoder.end(), stderr: stderr + stderrDecoder.end(), code, signal, timedOut, durationMs: Date.now() - started });
    };
    const remaining = deadline === undefined ? timeoutMs + 10_000 : Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => { stderr += "\nSSH diagnostic timed out; remote termination is not confirmed."; finish(null, null, true); }, remaining);
    conn.on("error", error => { stderr = error.level === "host-verification" ? "SSH host key verification failed." : "SSH connection/authentication failed; credentials hidden."; finish(null, null); });
    conn.on("close", () => { if (!finished) { stderr += "\nSSH disconnected; outcome unknown. Do not replay input."; finish(null, null); } });
    conn.on("ready", () => conn.exec(command, (error, stream) => {
      if (error) { stderr = "SSH command could not start."; finish(null, null); return; }
      const collect = (chunk: Buffer, err: boolean) => { const part = chunk.subarray(0, Math.max(0, 512 * 1024 - size)); size += part.length; if (err) stderr += stderrDecoder.write(part); else stdout += stdoutDecoder.write(part); };
      stream.on("data", (chunk: Buffer) => collect(chunk, false));
      stream.stderr.on("data", (chunk: Buffer) => collect(chunk, true));
      stream.on("error", () => { stderr += "\nSSH stream failed; outcome unknown."; finish(null, null); });
      stream.on("close", (code: number | undefined, signal: string | undefined) => finish(code ?? null, signal ? `SIG${signal}` as NodeJS.Signals : null));
      stream.end(input);
    }));
    conn.connect({ ...config, readyTimeout: Math.min(config.readyTimeout, remaining) });
  });
}

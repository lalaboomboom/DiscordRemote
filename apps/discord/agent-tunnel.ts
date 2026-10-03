/** Optional encrypted route for private coordinators without a public TLS name. */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { isIP } from "node:net";
import { passwordSshConfig } from "./ssh-password.js";
import { runReconnectingTunnel } from "./agent-tunnel-runtime.js";

async function main() {
  const localPort = Number(process.env.REMOTE_OPERATOR_TUNNEL_PORT || 8787);
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error("Invalid local tunnel port.");
  const values = parseEnv(readFileSync(".env.coordinator", "utf8"));
  const host = values.SSH_HOST, user = values.SSH_USER, password = values.SSH_PASSWORD;
  const port = Number(values.SSH_PORT || 22);
  if (!host || (!isIP(host) && !/^[A-Za-z0-9_.-]+$/.test(host)) || host.startsWith("-") || !user || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user) || !password || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Set valid SSH_HOST, SSH_USER, SSH_PORT and SSH_PASSWORD in .env.coordinator.");
  const mode = isIP(host) && values.SSH_HOST_KEY_SHA256 ? "direct-pinned" : "openssh";
  const config = await passwordSshConfig({ id: "coordinator", label: "coordinator", kind: "ssh", host, user, password, port, cwd: "/", hostKeySha256: values.SSH_HOST_KEY_SHA256 }, mode);
  const stopped = new AbortController();
  const stop = () => stopped.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    await runReconnectingTunnel({ localPort, config, log: message => console.log(`${new Date().toISOString()} ${message}`) }, stopped.signal);
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
main().catch(() => { console.error("Tunnel configuration/trust/listener failed. Verify .env.coordinator, the SSH host fingerprint and local port availability."); process.exitCode = 1; });

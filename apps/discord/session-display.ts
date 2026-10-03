/** Human-readable identity for Discord without replacing the opaque session ID. */
export interface SessionDisplayRecord {
  id: string;
  label: string;
  machine: string;
  machineLabel?: string;
  cwd?: string | null;
  provider?: string;
  kind?: string;
}

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/** VS Code Remote-SSH may expose an encoded authority instead of the host alias. */
export function machineDisplayName(machine: string): string {
  const value = clean(machine);
  const encoded = value.match(/^ssh-remote\+([0-9a-f]+)$/i)?.[1];
  if (encoded && encoded.length % 2 === 0) {
    try {
      const decoded = JSON.parse(Buffer.from(encoded, "hex").toString("utf8")) as Record<string, unknown>;
      for (const key of ["hostname", "hostName", "host", "name"]) {
        if (typeof decoded[key] === "string" && decoded[key].trim()) return clean(decoded[key]);
      }
    } catch { /* Keep the opaque authority if a future VS Code format changes. */ }
  }
  return value || "machine=?";
}

function compactPath(value: string, limit: number): string {
  const path = clean(value);
  if (path.length <= limit) return path;
  const parts = path.split("/").filter(Boolean);
  const tail = parts.slice(-3).join("/");
  const compact = `…/${tail}`;
  if (compact.length <= limit) return compact;
  return `…${path.slice(-(limit - 1))}`;
}

function providerName(provider: string | undefined): string {
  if (provider === "vscode" || provider === "vscode-agent") return "VS Code";
  if (provider === "tmux") return "tmux";
  return clean(provider ?? "terminal");
}

/** Keep the provider prefix and final characters that distinguish generations. */
export function shortSessionId(id: string): string {
  const value = clean(id);
  if (value.length <= 24) return value;
  const separator = value.indexOf("-");
  const prefix = separator > 0 ? value.slice(0, separator + 1) : "";
  return `${prefix}…${value.slice(-8)}`;
}

/** Machine, project folder, terminal name and provider are the primary identity. */
export function sessionDisplayName(session: SessionDisplayRecord): string {
  const machine = machineDisplayName(session.machineLabel ?? session.machine);
  const folder = session.cwd ? compactPath(session.cwd, 96) : "folder=?";
  const label = clean(session.kind || session.label) || "terminal";
  return `${machine} · ${folder} · ${label} · ${providerName(session.provider)}`;
}

/** A compact choice label for Discord's 100-character autocomplete limit. */
export function sessionChoiceName(session: SessionDisplayRecord): string {
  const machine = machineDisplayName(session.machineLabel ?? session.machine);
  const folder = session.cwd ? compactPath(session.cwd, 48) : "folder=?";
  const label = clean(session.kind || session.label) || "terminal";
  const provider = providerName(session.provider);
  const id = shortSessionId(session.id);
  const prefix = `${machine} · ${folder} · ${label} · ${provider}`;
  const room = Math.max(1, 100 - id.length - 3);
  return `${prefix.slice(0, room)} · ${id}`;
}

export function sessionReference(session: SessionDisplayRecord): string {
  return `${sessionDisplayName(session)} [${shortSessionId(session.id)}]`;
}

export function sessionListLine(session: SessionDisplayRecord, state: string): string {
  return `${sessionReference(session)} · ${state}`;
}

import { SessionError } from "./errors.js";
import { configuredHostById, hostForTerminal } from "./host-probe.js";
import { hostPlatform, HostTarget } from "./hosts.js";
import { validateExistingAttachment } from "./existing-terminal.js";
import { ChannelTargetIdentity } from "./channel-sessions.js";
import { CategoryBindingRecord, ChannelBindingRecord } from "./topology.js";
import { HostPlatform, requireWorkingDirectory, sameWorkingDirectory } from "./platform.js";

export interface AttachmentSession {
  id: string;
  machine: string;
  provider: string;
  cwd?: string | null;
  generation?: string;
  platform?: HostPlatform;
  remote?: boolean;
  sourceMachine?: string;
  cwdSource?: "shellIntegration" | "creationOptions" | "workspace";
  shared?: boolean;
  alive?: boolean;
  reachable?: boolean;
  inputProtocol?: string;
}

export interface AttachmentTarget {
  /** Configured machine on which the terminal actually runs. */
  host: HostTarget;
  /** Enrolled UI host carrying VS Code IPC; never the Remote-SSH target. */
  relayMachine?: string;
  /** Original provider identity; machine may be a raw VS Code authority. */
  identity?: ChannelTargetIdentity;
}

function sshMachine(value: string | undefined): string {
  if (!value || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new SessionError("Remote-SSH source machine is missing or invalid.");
  let alias = value;
  const authority = /^ssh-remote\+(.+)$/.exec(value);
  if (authority) {
    alias = authority[1];
    if (/^[a-f0-9]+$/i.test(alias) && alias.length % 2 === 0) {
      try {
        const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(alias, "hex")));
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid");
        const object = data as Record<string, unknown>;
        const names = ["hostname", "hostName", "host", "name"].filter(key => object[key] !== undefined).map(key => object[key]);
        if (!names.length || names.some(name => typeof name !== "string") || new Set(names).size !== 1) throw new Error("ambiguous");
        alias = names[0] as string;
      } catch { throw new SessionError("Remote-SSH authority is invalid or ambiguous."); }
    }
  }
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(alias) || /^(?:ssh-remote|wsl|dev-container|attached-container|codespaces|tunnel)$/i.test(alias)) {
    throw new SessionError("Only a known Remote-SSH machine can be attached; WSL and other remote authorities are unsupported.");
  }
  return alias;
}

/** Resolve physical host independently from the transport UI host. Resolution
 * is useful for discovery; attachment eligibility is checked separately below. */
export function resolveAttachmentTarget(targets: HostTarget[], session: AttachmentSession): AttachmentTarget {
  if (session.provider !== "vscode" && session.provider !== "vscode-agent") {
    if (!(session.provider === "tmux" && /^tmux-[a-f0-9]{10}$/.test(session.id)
      || session.provider === "conpty" && /^pty-[a-f0-9]{32}$/.test(session.id))) throw new SessionError("Choose a supported existing terminal from /sessions.");
    return { host: hostForTerminal(targets, session) };
  }
  if (!/^vsc-[a-f0-9]{16}-[a-f0-9]{8}$/.test(session.id) || !session.generation || !/^[a-f0-9]{32}$/.test(session.generation)
    || typeof session.machine !== "string" || !session.machine || session.machine.length > 200 || /[\x00-\x1f\x7f]/.test(session.machine)
    || typeof session.remote !== "boolean" || (session.platform !== "linux" && session.platform !== "win32")) {
    throw new SessionError("VS Code terminal has no valid provider identity or sharing generation.");
  }
  const ui = session.provider === "vscode-agent"
    ? configuredHostById(targets, session.machine)
    : configuredHostById(targets, "local");
  if (ui.kind !== (session.provider === "vscode-agent" ? "agent" : "local") || hostPlatform(ui) !== session.platform) {
    throw new SessionError("VS Code UI host does not match its configured machine/platform.");
  }
  const sourceMachine = session.provider === "vscode-agent" ? session.sourceMachine : session.machine;
  if (!session.remote && sourceMachine && (sourceMachine.includes("+") || sourceMachine === "ssh-remote")) {
    throw new SessionError("VS Code remote authority conflicts with its local metadata.");
  }
  const host = session.remote
    ? hostForTerminal(targets, { provider: "vscode", machine: sshMachine(session.provider === "vscode-agent" ? session.sourceMachine : session.machine) })
    : ui;
  if (session.remote && host.kind !== "ssh") throw new SessionError("Remote-SSH tabs require the actual configured SSH host; the UI relay is not a target fallback.");
  return { host, ...(session.provider === "vscode-agent" ? { relayMachine: ui.id } : {}),
    identity: { machine: session.machine, generation: session.generation, provider: session.provider } };
}

/** Pin the explicitly selected live provider generation and physical machine.
 * VS Code may report a new cwd after cd; the stored cwd remains a diagnostic
 * default. Managed providers keep their immutable creation directory pinned. */
export function validateAttachmentTarget(targets: HostTarget[], session: AttachmentSession, category: CategoryBindingRecord, expected?: ChannelBindingRecord): AttachmentTarget {
  const target = resolveAttachmentTarget(targets, session);
  configuredHostById(targets, category.hostId);
  if (session.shared === false || session.alive === false || session.reachable === false) throw new SessionError("Share a live, connected VS Code tab before attaching it.");
  if (target.identity && (session.shared !== true || session.alive !== true || session.inputProtocol !== "paced-submit-v1")) {
    throw new SessionError("Share a live tab using Remote Operator Terminal 0.1.6 or newer before attaching it.");
  }
  if (session.remote && session.cwdSource !== "shellIntegration" && session.cwdSource !== "creationOptions") {
    throw new SessionError("Remote-SSH attachment requires the terminal's reported working directory; workspace fallback or missing cwd source is insufficient.");
  }
  // Remote authorization was checked above. This existing validator now sees
  // the physical machine identity and target OS, rather than the UI relay.
  validateExistingAttachment({ id: session.id, machine: target.host.id, cwd: session.cwd, shared: session.shared, alive: session.alive }, category, hostPlatform(target.host));
  if (expected) {
    requireWorkingDirectory(expected.cwd, hostPlatform(target.host));
    const legacyRelay = expected.provider === "vscode-agent" && !expected.relayMachine && !session.remote && target.host.kind === "agent"
      ? expected.hostId : undefined;
    if (expected.hostId !== target.host.id || expected.categoryId !== category.categoryId || expected.guildId !== category.guildId
      || expected.terminalId !== session.id || expected.provider !== undefined && expected.provider !== session.provider
      || expected.terminalGeneration !== undefined && expected.terminalGeneration !== session.generation
      || target.identity && (expected.provider !== session.provider || expected.terminalGeneration !== session.generation)
      || (expected.relayMachine ?? legacyRelay) !== target.relayMachine
      || !target.identity && (!session.cwd || !sameWorkingDirectory(expected.cwd, session.cwd, hostPlatform(target.host)))) {
      throw new SessionError("The original terminal host, relay, provider, recorded directory or sharing generation changed; reattach explicitly. No action was redirected.");
    }
  }
  return target;
}

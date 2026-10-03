import { redact, TmuxRunner } from "./core.js";
import { SessionError } from "./errors.js";
import { formatHostResult, HostExecutor, hostForMachine, HostTarget } from "./hosts.js";

/** Persisted machine IDs must never be reinterpreted as mutable display labels. */
export function configuredHostById(targets: HostTarget[], id: string): HostTarget {
  const target = targets.find(candidate => candidate.id === id);
  if (!target) throw new SessionError(`Machine ${id} is not configured in the local host registry.`);
  return target;
}

/** Only legacy VS Code metadata contains host aliases instead of registry IDs. */
export function hostForTerminal(targets: HostTarget[], session: { machine?: string; provider?: string }): HostTarget {
  return session.provider === "vscode"
    ? hostForMachine(targets, session.machine)
    : configuredHostById(targets, session.machine ?? "");
}

/** Preflight the same local executable used by terminal creation. A packaged
 * tmux or TMUX_BIN does not have to appear in the diagnostic shell's PATH. */
export async function probeTmux(
  executor: HostExecutor,
  cwd: string,
  localRun: TmuxRunner,
  secrets: string[] = [],
): Promise<void> {
  if (executor.target.kind === "local") {
    try { await localRun(["-V"]); }
    catch (error) {
      const detail = error instanceof Error ? error.message : "version check failed";
      throw new SessionError(`tmux is not available on ${executor.target.label}. ${redact(detail, secrets).slice(0, 400)}`);
    }
    return;
  }
  if (executor.target.kind !== "ssh") throw new SessionError("Agent preflight must use its authenticated provider.");
  const result = await executor.run("tmux -V", 10_000, cwd);
  if (result.code !== 0 || result.timedOut) {
    throw new SessionError(`tmux is not available on ${executor.target.label}. ${redact(formatHostResult(result), secrets).slice(0, 400)}`);
  }
}

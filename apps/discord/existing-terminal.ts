import { SessionError } from "./errors.js";
import { CategoryBindingRecord } from "./topology.js";
import { validWorkingDirectory, HostPlatform } from "./platform.js";

export function validateExistingAttachment(session: {
  id: string; machine: string; cwd?: string | null; remote?: boolean;
  shared?: boolean; alive?: boolean;
}, category: CategoryBindingRecord, platform: HostPlatform): void {
  if (session.remote) throw new SessionError("Resolve this Remote-SSH tab to its configured physical SSH host before attaching it; the UI relay is not its terminal machine.");
  if (session.shared === false || session.alive === false) throw new SessionError("Share a live VS Code tab before attaching it.");
  if (session.machine !== category.hostId) throw new SessionError("Terminal machine must match the category's configured physical host.");
  if (!validWorkingDirectory(session.cwd, platform)) throw new SessionError("Terminal working directory must be a valid absolute path on the target machine.");
}

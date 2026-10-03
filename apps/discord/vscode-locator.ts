import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** A per-user path hint for the UI extension; never include enrollment data. */
export function publishVscodeBridgeDirectory(directory: string, userHome = homedir()): void {
  const root = resolve(userHome, ".remote-operator");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const destination = resolve(root, "vscode-bridge.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, bridgeDirectory: resolve(directory) }), { mode: 0o600 });
  renameSync(temporary, destination);
}

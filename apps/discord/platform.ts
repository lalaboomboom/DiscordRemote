import { existsSync } from "node:fs";
import { win32, posix, join } from "node:path";
import { SessionError } from "./errors.js";

export type HostPlatform = "win32" | "linux";

export function validWorkingDirectory(value: unknown, platform?: HostPlatform): value is string {
  if (typeof value !== "string" || !value || value.length > 500 || /[\x00-\x1f\x7f]/.test(value)) return false;
  const windows = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value)
    && !/^\\\\[?.]\\/.test(value) && win32.isAbsolute(value);
  const linux = value.startsWith("/") && posix.isAbsolute(value);
  return platform === "win32" ? windows : platform === "linux" ? linux : windows || linux;
}

export function requireWorkingDirectory(value: string, platform?: HostPlatform): void {
  if (!validWorkingDirectory(value, platform)) throw new SessionError(`Working directory must be an absolute ${platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : "target OS"} path, at most 500 characters.`);
}

export function localPlatform(): HostPlatform {
  if (process.platform !== "win32" && process.platform !== "linux") throw new SessionError("This release supports Windows and Linux hosts.");
  return process.platform;
}

export function sameWorkingDirectory(a: string, b: string, platform: HostPlatform): boolean {
  requireWorkingDirectory(a, platform); requireWorkingDirectory(b, platform);
  const paths = platform === "win32" ? win32 : posix;
  // Preserve case even on Windows: NTFS directories may be case-sensitive.
  const normalize = (value: string) => {
    const absolute = paths.resolve(value).replace(platform === "win32" ? /[\\/]+$/ : /\/+$/, "");
    // VS Code URI.fsPath lowercases drive letters; keep directory-name case.
    return platform === "win32" ? absolute.replace(/^[a-z]:/, drive => drive.toUpperCase()) : absolute;
  };
  return normalize(a) === normalize(b);
}

export function windowsShell(): string {
  const pwsh = join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  return existsSync(pwsh) ? pwsh : join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Native process essentials only; Discord/SSH credentials never enter shells. */
export function windowsEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = new Set(["path", "systemroot", "windir", "comspec", "pathext", "userprofile", "username", "homedrive", "homepath", "appdata", "localappdata", "programfiles", "programfiles(x86)", "programdata", "temp", "tmp"]);
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => names.has(key.toLowerCase()) && value !== undefined));
}

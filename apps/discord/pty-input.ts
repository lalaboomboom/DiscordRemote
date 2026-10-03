import { setTimeout as delay } from "node:timers/promises";
import { validateInput } from "./core.js";

/** Codex 0.155.0 on Windows keeps a 120 ms Enter-suppression window after
 * fast characters and flushes a paste after 60 ms idle. 250 ms was validated
 * against the real Windows TUI, including Unicode prompts. This is transport
 * pacing, not application acknowledgement. Never retry the submit key.
 * https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/tui/src/bottom_pane/paste_burst.rs
 */
export const PTY_SUBMIT_GAP_MS = 250;
export const PTY_INPUT_VERSION = "paced-enter-v1";

export async function submitPtyInput(
  text: string,
  write: (text: string) => void,
  alive: () => boolean,
  deadline: number,
  wait: (ms: number) => Promise<unknown> = delay,
  now: () => number = Date.now,
): Promise<void> {
  validateInput(text);
  if (!alive()) throw new Error("Terminal has exited; no input sent.");
  if (deadline - now() <= PTY_SUBMIT_GAP_MS) throw new Error("Request expires before submit; no input sent.");
  write(text);
  await wait(PTY_SUBMIT_GAP_MS);
  if (!alive() || now() >= deadline) throw new Error("Text was delivered but Enter was not sent: terminal exited or request expired. Inspect output; do not automatically retry.");
  write("\r");
}

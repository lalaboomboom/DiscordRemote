import { createHash } from "node:crypto";
import { basename } from "node:path";

/** Keep large prompts out of the interactive PTY. The attachment is read by
 * the foreground application from a file in its working directory instead. */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;

const TEXT_EXTENSIONS = new Set([
  ".bash", ".c", ".cfg", ".conf", ".cjs", ".cpp", ".css", ".csv", ".diff",
  ".go", ".h", ".hpp", ".html", ".ini", ".java", ".js", ".json", ".jsonl",
  ".jsx", ".log", ".markdown", ".md", ".mjs", ".patch", ".php", ".py", ".r",
  ".rb", ".rs", ".sh", ".sql", ".svg", ".tex", ".toml", ".ts", ".tsx", ".txt",
  ".xml", ".yaml", ".yml",
]);

const TEXT_CONTENT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
]);

export interface AttachmentLike {
  name?: string | null;
  url: string;
  size?: number;
  contentType?: string | null;
}

export interface StagedAttachment {
  originalName: string;
  relativePath: string;
  bytes: number;
  sha256: string;
}

export function isTextAttachment(attachment: AttachmentLike): boolean {
  const contentType = attachment.contentType?.toLowerCase().split(";", 1)[0].trim();
  if (contentType?.startsWith("text/") || TEXT_CONTENT_TYPES.has(contentType ?? "")) return true;
  const name = (attachment.name ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 && TEXT_EXTENSIONS.has(name.slice(dot));
}

export function safeAttachmentName(name: string | null | undefined, fallback = "attachment.txt"): string {
  const source = basename(name?.trim() || fallback).normalize("NFKC");
  const cleaned = source.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 48);
  return cleaned || fallback;
}

export function attachmentPath(messageId: string, index: number, name: string | null | undefined): string {
  const prefix = messageId.replace(/[^0-9A-Za-z_-]/g, "_").slice(0, 24) || "message";
  const safeIndex = Number.isInteger(index) && index >= 0 && index < MAX_ATTACHMENTS ? index : 0;
  return `.discord-bridge/inbox/${prefix}-${safeIndex}-${safeAttachmentName(name)}`;
}

export function attachmentDigest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function buildAttachmentPrompt(caption: string, files: StagedAttachment[]): string {
  const references = files.map(file => file.relativePath).join(", ");
  const base = `Read these files completely as the full request: ${references}.`;
  if (base.length > 500) throw new Error("Attachment references exceed the terminal input limit.");
  const cleanCaption = caption.trim().replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ");
  if (!cleanCaption) return base;
  const suffix = " Additional instruction: ";
  const available = Math.max(0, 500 - base.length - suffix.length);
  return `${base}${suffix}${cleanCaption.slice(0, available)}`;
}

export async function downloadAttachment(attachment: AttachmentLike, maxBytes = MAX_ATTACHMENT_BYTES): Promise<Buffer> {
  let parsed: URL;
  try { parsed = new URL(attachment.url); } catch { throw new Error("Attachment URL is invalid."); }
  if (parsed.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(parsed.hostname)) {
    throw new Error("Only Discord HTTPS attachments are supported.");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("Attachment size limit is invalid.");
  if (attachment.size !== undefined && (!Number.isInteger(attachment.size) || attachment.size < 0 || attachment.size > maxBytes)) {
    throw new Error(`Attachment is too large; the limit is ${maxBytes} bytes.`);
  }
  const response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Discord attachment download failed (HTTP ${response.status}).`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Attachment is too large; the limit is ${maxBytes} bytes.`);
  if (!response.body) throw new Error("Discord returned an empty attachment body.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) throw new Error(`Attachment is too large; the limit is ${maxBytes} bytes.`);
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** Discord's content limit includes labels, commands and code fences. */
export function fitDiscordMessage(content: string, limit = 1900): string {
  if (content.length <= limit) return content;
  let result = content.slice(0, Math.max(0, limit - 32));
  if (((result.match(/```/g) ?? []).length % 2) !== 0) result += "\n```";
  return result + "\n… (truncated; use /output)";
}

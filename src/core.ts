import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ModelRef = { providerID: string; modelID: string; name: string };
export type ChatState = { directory: string; sessionID?: string; model?: ModelRef };
export type State = { chats: Record<string, ChatState> };

export function parseAllowedIds(value: string): Set<number> {
  return new Set(value.split(",").map((part) => Number(part.trim())).filter((id) => Number.isSafeInteger(id) && id > 0));
}

export function splitTelegram(text: string, limit = 4000): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function normalizeSessionName(value: string): string | undefined {
  if (/[\u0000-\u001f]/.test(value)) return undefined;
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80) return undefined;
  return name;
}

export function resolveWorkspace(value: string, fallback: string): string | undefined {
  const candidate = value.trim() || fallback;
  return existsSync(candidate) ? candidate : undefined;
}

export function visibleText(parts: Array<{ type: string; text?: string }>): string {
  return parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text!.trim()).filter(Boolean).join("\n");
}

export function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

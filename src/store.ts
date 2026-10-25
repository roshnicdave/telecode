// Portable JSON session store. Sessions live as one JSON file per session,
// so the MCP server and the Telegram bot (same process) share one source of
// truth and any conforming agent can read/write them through the MCP tools.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  model?: string;
  time: number;
}

export interface PendingPrompt {
  id: string;
  text: string;
  time: number;
}

export interface Session {
  id: string;
  title: string;
  directory: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: SessionMessage[];
  pending: PendingPrompt[];
  interrupted?: boolean;
  compactRequested?: boolean;
}

export class Store {
  private dir: string;
  private cache = new Map<string, Session>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.loadIndex();
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private loadIndex(): void {
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -".json".length);
      try {
        const s = JSON.parse(readFileSync(this.path(id), "utf8")) as Session;
        this.cache.set(s.id, s);
      } catch {
        // ignore corrupt files
      }
    }
  }

  private save(s: Session): void {
    writeFileSync(this.path(s.id), JSON.stringify(s, null, 2));
    this.cache.set(s.id, s);
  }

  list(): Session[] {
    return [...this.cache.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Session | undefined {
    return this.cache.get(id);
  }

  create(opts: { title?: string; directory?: string; model?: string } = {}): Session {
    const now = Date.now();
    const s: Session = {
      id: randomUUID(),
      title: opts.title || "New session",
      directory: opts.directory || process.cwd(),
      model: opts.model || "",
      createdAt: now,
      updatedAt: now,
      messages: [],
      pending: [],
    };
    this.save(s);
    return s;
  }

  update(id: string, fn: (s: Session) => void): Session {
    const s = this.get(id);
    if (!s) throw new Error(`session not found: ${id}`);
    fn(s);
    s.updatedAt = Date.now();
    this.save(s);
    return s;
  }

  remove(id: string): boolean {
    const s = this.get(id);
    if (!s) return false;
    rmSync(this.path(id), { force: true });
    this.cache.delete(id);
    return true;
  }

  addMessage(id: string, msg: Omit<SessionMessage, "id" | "time">): SessionMessage {
    const full: SessionMessage = { ...msg, id: randomUUID(), time: Date.now() };
    this.update(id, (s) => s.messages.push(full));
    return full;
  }

  addPending(id: string, text: string): PendingPrompt {
    const p: PendingPrompt = { id: randomUUID(), text, time: Date.now() };
    this.update(id, (s) => {
      s.pending.push(p);
      s.interrupted = false;
    });
    return p;
  }

  takePending(id?: string): { session: Session; pending: PendingPrompt[] }[] {
    if (id) {
      const s = this.get(id);
      return s ? [{ session: s, pending: s.pending }] : [];
    }
    return this.list()
      .filter((s) => s.pending.length > 0)
      .map((s) => ({ session: s, pending: s.pending }));
  }

  clearPending(id: string, pendingIds?: string[]): void {
    this.update(id, (s) => {
      if (pendingIds && pendingIds.length) {
        const set = new Set(pendingIds);
        s.pending = s.pending.filter((p) => !set.has(p.id));
      } else {
        s.pending = [];
      }
    });
  }
}

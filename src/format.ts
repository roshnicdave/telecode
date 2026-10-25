// Markdown-ish text -> Telegram HTML, plus chunking helpers (ported from telecode).

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function relTime(ms?: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 0) return "now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function inlineFormat(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1">$1</a>');
  return s;
}

function pushText(blocks: { html: string }[], text: string): void {
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (p) blocks.push({ html: inlineFormat(p) });
  }
}

export function textToBlocks(text: string): { html: string }[] {
  const blocks: { html: string }[] = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) pushText(blocks, text.slice(last, m.index));
    const lang = (m[1] || "").trim();
    blocks.push({
      html: `<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(m[2])}</code></pre>`,
    });
    last = fence.lastIndex;
  }
  if (last < text.length) pushText(blocks, text.slice(last));
  return blocks;
}

export function packBlocks(blocks: { html: string }[], limit = 4000): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const b of blocks) {
    const html = b.html;
    if (html.length > limit) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      for (const piece of hardSplit(html, limit)) chunks.push(piece);
      continue;
    }
    const sep = cur ? "\n\n" : "";
    if (cur && cur.length + sep.length + html.length > limit) {
      chunks.push(cur);
      cur = html;
    } else {
      cur = cur ? cur + sep + html : html;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function hardSplit(html: string, limit: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of html.split("\n")) {
    const piece = line + "\n";
    if (cur && cur.length + piece.length > limit) {
      out.push(cur);
      cur = piece;
    } else {
      cur += piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

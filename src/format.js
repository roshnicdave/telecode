// Markdown-ish text → Telegram HTML, plus chunking helpers.

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function relTime(ms) {
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

function inlineFormat(text) {
  let s = escapeHtml(text);
  // inline code
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
  // bold
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  // bare URLs → links
  s = s.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1">$1</a>');
  return s;
}

function pushText(blocks, text) {
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (p) blocks.push({ html: inlineFormat(p) });
  }
}

// Convert markdown-ish text into an array of HTML blocks:
// normal paragraphs and <pre><code> fenced code blocks.
export function textToBlocks(text) {
  const blocks = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m;
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

// Pack blocks into Telegram-sized chunks (≤ limit chars) without splitting a
// block when possible; oversized blocks are hard-split on newlines.
export function packBlocks(blocks, limit = 4000) {
  const chunks = [];
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

function hardSplit(html, limit) {
  const out = [];
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

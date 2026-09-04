// The embed widget. Ported from src/lib/server/widget.ts and routes/embed/[id].
//
// NOTE THE ABSENCE: there is no Datastar on this page, deliberately.
//
//  1. The default bundle evaluates expressions with Function(), so it needs
//     `script-src 'unsafe-eval'`. This document runs under `default-src 'none'`
//     with a per-request nonce, and it renders text written by strangers.
//  2. Datastar's own docs are explicit that even CSP/nonce mode "does not make
//     Datastar expressions safe to use with untrusted content."
//
// So the widget stays a pure string-rendered document. Which costs nothing —
// it has no interactivity to give up. The same was already true in SvelteKit:
// that route is a `+server.ts` returning a string, using zero Svelte.
import { esc } from "./render.ts";
import { parseCssVars, WALL_LAYOUTS, WALL_THEMES, WALL_DENSITIES } from "./walls.ts";
import type { WallRow, WallItemRow } from "./store.ts";

export function frameAncestors(allowed: string[] | null): string {
  if (allowed === null) return "*";
  if (allowed.length === 0) return "'none'";
  return allowed.map((e) => {
    const h = e.trim().toLowerCase();
    return h.startsWith("*.") ? `https://*.${h.slice(2)}` : `https://${h}`;
  }).join(" ");
}

// Per-embed overrides forwarded by the loader, so one wall can appear twice on
// a site with two different looks. Validated against fixed allow-lists.
export function applyOverrides(w: WallRow, q: URLSearchParams): WallRow {
  const pick = (n: string, allowed: string[], cur: string) => {
    const v = q.get(n);
    return v && allowed.includes(v) ? v : cur;
  };
  const dates = q.get("dates");
  return {
    ...w,
    layout: pick("layout", WALL_LAYOUTS, w.layout),
    theme: pick("theme", WALL_THEMES, w.theme),
    density: pick("density", WALL_DENSITIES, w.density),
    show_dates: dates === "on" ? 1 : dates === "off" ? 0 : w.show_dates,
  };
}

const HEIGHT_SCRIPT =
  `(function(){var last=0;function send(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);` +
  `if(h!==last){last=h;parent.postMessage({type:'sp:height',height:h},'*');}}` +
  `if(window.ResizeObserver){new ResizeObserver(send).observe(document.documentElement);}` +
  `window.addEventListener('load',send);send();})();`;

const styles = (vars: Record<string, string>) =>
  `:root{--sp-bg:#fff;--sp-card:#fff;--sp-ink:#18181b;--sp-muted:#71717a;--sp-border:#e4e4e7;` +
  `--sp-accent:#2563eb;--sp-radius:10px;--sp-font:ui-sans-serif,system-ui,sans-serif;` +
  Object.entries(vars).map(([k, v]) => `${k}:${v};`).join("") + `}` +
  `[data-sp-theme=dark]{--sp-bg:#0f0f12;--sp-card:#17171b;--sp-ink:#ededf0;--sp-muted:#9a9aa4;--sp-border:#2a2a31}` +
  `@media(prefers-color-scheme:dark){[data-sp-theme=auto]{--sp-bg:#0f0f12;--sp-card:#17171b;--sp-ink:#ededf0;--sp-muted:#9a9aa4;--sp-border:#2a2a31}}` +
  `*{box-sizing:border-box}body{margin:0;background:var(--sp-bg);color:var(--sp-ink);font-family:var(--sp-font);font-size:14px;line-height:1.5}` +
  `.sp-wall{display:grid;gap:12px;padding:12px}` +
  `.sp-wall[data-sp-layout=grid]{grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}` +
  `.sp-wall[data-sp-density=compact]{gap:8px;padding:8px}` +
  `.sp-card{margin:0;background:var(--sp-card);border:1px solid var(--sp-border);border-radius:var(--sp-radius);padding:14px}` +
  `.sp-head{display:flex;gap:9px;align-items:center;margin-bottom:8px}` +
  `.sp-avatar{width:36px;height:36px;border-radius:99px;object-fit:cover;background:var(--sp-border)}` +
  `.sp-initials{width:36px;height:36px;border-radius:99px;background:var(--sp-border);color:var(--sp-muted);display:flex;align-items:center;justify-content:center;font-weight:600}` +
  `.sp-who{display:flex;flex-direction:column}.sp-name{font-weight:600}` +
  `.sp-handle,.sp-date{color:var(--sp-muted);font-size:12px}` +
  `.sp-body{margin:0;font-size:14px}` +
  `.sp-foot{display:flex;gap:10px;align-items:center;margin-top:9px;font-size:12px}` +
  `.sp-link{color:var(--sp-accent)}` +
  `.sp-wall[data-sp-dates=off] .sp-date{display:none}`;

const initials = (name: string | null, handle: string | null) =>
  [...(name || handle || "?")][0]!.toUpperCase();

function card(it: WallItemRow): string {
  const name = it.author_name ?? it.author_handle ?? "";
  const handle = it.author_handle ? `<span class="sp-handle">@${esc(it.author_handle)}</span>` : "";
  const date = it.posted_at
    ? `<span class="sp-date">${esc(new Date(it.posted_at).toLocaleDateString("en-US",
        { month: "short", day: "numeric", year: "numeric" }))}</span>` : "";
  // rel=noopener is not optional: the iframe is sandboxed with
  // allow-popups-to-escape-sandbox, so an opened tab must not keep a handle
  // back to this document.
  // Proxied through us, never the platform CDN: hotlinking would leak every
  // wall visitor's IP to X. The proxy takes a testimonial id, not a URL, so
  // there is no user-supplied URL for it to be tricked into fetching.
  const avatar = it.author_avatar
    ? `<img class="sp-avatar" src="/api/v1/avatar/${esc(it.id)}" alt="" loading="lazy" ` +
      `decoding="async" width="36" height="36">`
    : `<span class="sp-initials" aria-hidden="true">${esc(initials(it.author_name, it.author_handle))}</span>`;
  return `<figure class="sp-card">` +
    `<div class="sp-head">${avatar}` +
    `<span class="sp-who"><span class="sp-name">${esc(name)}</span>${handle}</span></div>` +
    `<blockquote class="sp-body">${esc(it.content)}</blockquote>` +
    `<figcaption class="sp-foot">${date}<a class="sp-link" href="${esc(it.post_url)}" ` +
    `target="_blank" rel="noopener noreferrer nofollow ugc">View original</a></figcaption></figure>`;
}

export function renderWallHtml(w: WallRow, items: WallItemRow[], nonce: string): string {
  // An embed with nothing approved renders an empty container, not an error.
  const body = items.length ? items.map(card).join("") : `<p class="sp-empty"></p>`;
  return `<!doctype html>
<html lang="en" data-sp-theme="${esc(w.theme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Testimonials</title>
<style nonce="${nonce}">${styles(parseCssVars(w.css_vars))}</style>
</head>
<body>
<div class="sp-wall" data-sp-layout="${esc(w.layout)}" data-sp-density="${esc(w.density)}" data-sp-dates="${w.show_dates ? "on" : "off"}">${body}</div>
<script nonce="${nonce}">${HEIGHT_SCRIPT}</script>
</body>
</html>`;
}

export function embedHeaders(nonce: string, allowed: string[] | null): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    // frame-ancestors is delivered by THIS response's headers, so a cached
    // copy keeps enforcing whatever policy was current when it was stored.
    // The original ships `public, max-age=60` unconditionally: tightening a
    // wall's allow-list then does not bite until the cached copy expires, and
    // nothing can invalidate what is already stored. Revalidating every time
    // is the only policy under which a restriction takes effect at once. The
    // document is small and carries a per-request nonce, so there was never
    // much to cache.
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": [
      "default-src 'none'",
      "img-src 'self' data:",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${frameAncestors(allowed)}`,
    ].join("; "),
  };
}

// ---------- dashboard rendering ----------

export function renderWalls(ws: WallRow[], origin: string): string {
  if (!ws.length)
    return `<div id="walls"><div class="empty"><h2>No walls yet</h2>` +
      `<p>Create one to get an embed snippet for your site.</p></div></div>`;
  return `<div id="walls">` + ws.map((w) => {
    const domains = w.allowed_domains ? (JSON.parse(w.allowed_domains) as string[]) : null;
    const snippet = `<iframe src="${origin}/embed/${w.id}" style="width:100%;border:0" loading="lazy" title="Testimonials"></iframe>`;
    return `<article class="t wall" id="wall-${esc(w.id)}"><div class="who"><div>` +
      `<div class="meta"><span class="name">${esc(w.name)}</span>` +
      `<span class="plat">${w.enabled ? "Live" : "Paused"}</span>` +
      `<code class="mono">${esc(w.id)}</code></div>` +
      `<div class="foot"><a href="/embed/${esc(w.id)}" target="_blank" rel="noopener">Preview</a>` +
      `<span>${domains === null ? "Visible on any site" : "Restricted"}</span></div>` +
      `<label class="snippet"><span>Embed snippet</span>` +
      `<textarea rows="2" readonly onclick="this.select()">${esc(snippet)}</textarea></label>` +
      `<label class="snippet"><span>Allowed domains <em>(blank = any site)</em></span>` +
      `<input type="text" value="${esc(domains ? domains.join(", ") : "")}" ` +
      `data-on:change__debounce.400ms="@patch('/walls/${esc(w.id)}?domains=' + encodeURIComponent(evt.target.value))" ` +
      `placeholder="example.com, *.shop.example.com"></label>` +
      `</div></div><div class="acts">` +
      `<button class="btn sm" data-on:click="@patch('/walls/${esc(w.id)}?enabled=${!w.enabled}')">${w.enabled ? "Pause" : "Enable"}</button>` +
      `<button class="btn sm danger" data-on:click="@delete('/walls/${esc(w.id)}')">Delete</button>` +
      `</div></article>`;
  }).join("") + `</div>`;
}

export const renderWallMsg = (kind: "" | "ok" | "err", text = "") =>
  kind === "" ? `<div id="wall-msg"></div>`
  : `<div id="wall-msg"><div class="alert ${kind}" role="${kind === "ok" ? "status" : "alert"}">${text}</div></div>`;

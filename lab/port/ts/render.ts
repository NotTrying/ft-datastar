// HTML fragments. Each has a stable id — that id is what Datastar morphs
// against, so the same function serves both the first page render and every
// later SSE patch. There is no second "client-side" version of any of this.
import type { Testimonial, Status } from "./store.ts";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const renderStats = (c: Record<Status, number>) =>
  `<div id="stats" class="stats">` +
  `<div class="stat pending"><b>${c.pending}</b><span>Pending</span></div>` +
  `<div class="stat approved"><b>${c.approved}</b><span>Approved</span></div>` +
  `<div class="stat dismissed"><b>${c.dismissed}</b><span>Dismissed</span></div></div>`;

export const renderTabs = (c: Record<Status, number>, active: Status) =>
  `<div id="tabs" class="tabs" role="tablist">` +
  ([["pending", "Pending"], ["approved", "Approved"], ["dismissed", "Dismissed"]] as const)
    .map(([key, label]) =>
      `<button class="tab" role="tab" aria-selected="${key === active}" ` +
      `data-on:click="$tab = '${key}'; @get('/testimonials')">${label} (${c[key]})</button>`)
    .join("") + `</div>`;

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const btn = (id: string, status: Status, label: string, cls: string) =>
  `<button class="${cls}" data-on:click="@patch('/testimonials/${esc(id)}?status=${status}')">${label}</button>`;

const del = (id: string) =>
  `<button class="btn sm danger" data-on:click="@delete('/testimonials/${esc(id)}')">Remove</button>`;

export function renderList(items: Testimonial[], tab: Status, total: number): string {
  if (total === 0)
    return `<div id="list" class="empty"><h2>Nothing here yet</h2>` +
      `<p>Add a review you already have using the panel above, or add an X handle ` +
      `and we&rsquo;ll find posts that mention it.</p></div>`;
  if (items.length === 0)
    return `<div id="list" class="empty"><p>No ${esc(tab)} testimonials</p></div>`;

  return `<div id="list" class="list">` + items.map((t) => {
    const name = t.author_name || t.author_handle || "Unknown";
    const initial = [...name][0]?.toUpperCase() ?? "?";
    const acts =
      t.status === "pending" ? btn(t.id, "approved", "Approve", "btn sm ok") + btn(t.id, "dismissed", "Dismiss", "btn sm")
      : t.status === "approved" ? del(t.id)
      : btn(t.id, "approved", "Approve", "btn sm") + del(t.id);

    return `<article class="t"><div class="who"><div class="av">${esc(initial)}</div><div>` +
      `<div class="meta"><span class="name">${esc(name)}</span>` +
      (t.author_handle ? `<span class="handle">@${esc(t.author_handle)}</span>` : "") +
      `<span class="plat">${esc(t.platform)}</span></div>` +
      `<p>${esc(t.content)}</p><div class="foot">` +
      (t.posted_at ? `<span>${fmtDate(t.posted_at)}</span>` : "") +
      // rel=noopener: this href is user-supplied and points off-site.
      `<a href="${esc(t.post_url)}" target="_blank" rel="noopener noreferrer">View original</a>` +
      `</div></div></div><div class="acts">${acts}</div></article>`;
  }).join("") + `</div>`;
}

export const renderMsg = (kind: "" | "ok" | "err", text = "") =>
  kind === "" ? `<div id="form-msg"></div>`
  : `<div id="form-msg"><div class="alert ${kind}" role="${kind === "ok" ? "status" : "alert"}">${text}</div></div>`;

// Monitored handles + plan limits. Ported from
// src/routes/(member)/dashboard/handles/+page.server.ts and lib/config/pricing.ts.
import type { HandleRow } from "./store.ts";
import { esc } from "./render.ts";

export type Limits = { maxHandles: number; scansPerMonth: number; maxTestimonials: number };

export const PLANS: Record<string, Limits> = {
  free:       { maxHandles: 1,  scansPerMonth: 30,  maxTestimonials: 10 },
  pro:        { maxHandles: 5,  scansPerMonth: 500, maxTestimonials: 200 },
  enterprise: { maxHandles: -1, scansPerMonth: -1,  maxTestimonials: -1 },
};

// -1 means unlimited, matching canUseLimit() in the original.
export const canUse = (limit: number, used: number) => limit === -1 || used < limit;
export const limitsFor = (plan: string): Limits => PLANS[plan] ?? PLANS.free!;

// Validation, ported verbatim from the original's addHandle action.
export function validateHandle(raw: string): { ok: true; handle: string } | { ok: false; error: string } {
  const h = (raw ?? "").trim().replace(/^@/, "");
  if (!h) return { ok: false, error: "Handle is required" };
  if (h.length < 1 || h.length > 50)
    return { ok: false, error: "Handle must be between 1 and 50 characters" };
  if (!/^[a-zA-Z0-9_]+$/.test(h))
    return { ok: false, error: "Handle can only contain letters, numbers, and underscores" };
  return { ok: true, handle: h };
}

const fmt = (ms: number | null) =>
  ms === null ? "Never"
    : new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function renderHandles(hs: HandleRow[]): string {
  const body = hs.length === 0
    ? `<div class="empty"><h2>No handles yet</h2>` +
      `<p>Add an X handle above and we&rsquo;ll look for posts that mention it.</p></div>`
    : hs.map((h) =>
        `<article class="t handle" id="handle-${esc(h.id)}"><div class="who"><div class="av">@</div><div>` +
        `<div class="meta"><span class="name">@${esc(h.handle)}</span>` +
        `<span class="plat">${esc(h.platform)}</span></div>` +
        `<div class="foot"><span>${h.pending} pending &middot; ${h.approved} approved</span>` +
        `<span>Last scan: ${esc(fmt(h.last_scanned_at))}</span></div></div></div><div class="acts">` +
        `<button class="btn sm ok" data-on:click="@post('/scan?id=${esc(h.id)}')" data-attr:disabled="$_scanning">Scan now</button>` +
        `<button class="btn sm danger" data-on:click="@delete('/handles/${esc(h.id)}')" data-attr:disabled="$_scanning">Remove</button>` +
        `</div></article>`).join("");
  return `<div id="handles">${body}</div>`;
}

export const renderHandleMsg = (kind: "" | "ok" | "err", text = "") =>
  kind === "" ? `<div id="handle-msg"></div>`
  : `<div id="handle-msg"><div class="alert ${kind}" role="${kind === "ok" ? "status" : "alert"}">${text}</div></div>`;

export const renderPlan = (used: number, lim: Limits) =>
  `<p id="plan-line" class="muted small">Monitoring ${used} of ` +
  `${lim.maxHandles === -1 ? "unlimited" : lim.maxHandles} handles on your plan.</p>`;

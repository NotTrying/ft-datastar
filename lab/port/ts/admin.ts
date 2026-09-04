// Admin. Ported from (member)/admin/+layout.server.ts and admin/users.
//
// The original carries a warning worth repeating: in SvelteKit, form actions do
// NOT run the layout's `load`, so the layout's admin gate does not protect
// them and every action re-checks the role itself. Datastar has no layout
// gate to be lulled by — every route is explicitly wrapped — but the same
// discipline applies, so `requireAdmin` wraps each one below.
import { esc } from "./render.ts";
import type { Store, AdminUserRow } from "./store.ts";

export const MAX_BAN_REASON = 500;

/** A ban with a past expiry has lapsed and is no longer a ban. */
export function isBanned(u: { banned: number; ban_expires: number | null }): boolean {
  if (!u.banned) return false;
  return u.ban_expires === null || u.ban_expires > Date.now();
}

export const isAdmin = (u: { role: string } | null) => u?.role === "admin";

export function validateBan(
  actorId: string, targetId: string, reason: string,
): { ok: true; reason: string } | { ok: false; error: string } {
  if (!targetId) return { ok: false, error: "User ID is required" };
  if (targetId === actorId) return { ok: false, error: "You cannot ban yourself" };
  const r = (reason ?? "").trim();
  if (!r) return { ok: false, error: "Ban reason is required" };
  if (r.length > MAX_BAN_REASON)
    return { ok: false, error: `Ban reason must be ${MAX_BAN_REASON} characters or less` };
  return { ok: true, reason: r };
}

export const renderAdminMsg = (kind: "" | "ok" | "err", text = "") =>
  kind === "" ? `<div id="admin-msg"></div>`
  : `<div id="admin-msg"><div class="alert ${kind}" role="${kind === "ok" ? "status" : "alert"}">${text}</div></div>`;

const when = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function renderUsers(store: Store, users: AdminUserRow[], actorId: string): string {
  const rows = users.map((u) => {
    const banned = isBanned(u);
    const self = u.id === actorId;
    const orgs = store.orgsFor(u.id).length;
    return `<article class="t adminuser${banned ? " banned" : ""}" id="user-${esc(u.id)}">` +
      `<div class="who"><div class="av">${esc((u.name || u.email)[0]!.toUpperCase())}</div><div>` +
      `<div class="meta"><span class="name">${esc(u.name || u.email)}</span>` +
      `<span class="plat">${esc(u.role)}</span>` +
      `<span class="plat">${esc(u.plan)}</span>` +
      (banned ? `<span class="plat banned-tag">banned</span>` : "") +
      (self ? `<span class="muted small">you</span>` : "") + `</div>` +
      `<div class="foot"><span>${esc(u.email)}</span>` +
      `<span>${orgs} org${orgs === 1 ? "" : "s"}</span>` +
      `<span>Joined ${esc(when(u.created_at))}</span>` +
      (banned && u.ban_reason ? `<span class="muted">“${esc(u.ban_reason)}”</span>` : "") +
      `</div></div></div><div class="acts">` +
      (self
        ? `<span class="muted small">—</span>`
        : banned
          ? `<button class="btn sm" data-on:click="@post('/admin/users/${esc(u.id)}/unban')">Unban</button>` +
            `<button class="btn sm danger" data-on:click="@delete('/admin/users/${esc(u.id)}')">Delete</button>`
          : `<button class="btn sm" data-on:click="$_banning = '${esc(u.id)}'">Ban</button>` +
            `<button class="btn sm danger" data-on:click="@delete('/admin/users/${esc(u.id)}')">Delete</button>`) +
      `</div></article>` +
      // The ban form is inline and shown only for the row being banned, so the
      // reason never has to live in a shared signal across rows.
      `<div class="banform" data-show="$_banning == '${esc(u.id)}'">` +
      `<form data-on:submit__prevent="@post('/admin/users/${esc(u.id)}/ban')">` +
      `<div class="row"><label class="grow"><span>Reason</span>` +
      `<input type="text" maxlength="${MAX_BAN_REASON}" data-bind:ban-reason ` +
      `placeholder="Why is this account being banned?"></label>` +
      `<button type="submit" class="btn danger" data-attr:disabled="!$banReason">Confirm ban</button>` +
      `<button type="button" class="btn" data-on:click="$_banning = ''">Cancel</button>` +
      `</div></form></div>`;
  }).join("");
  return `<div id="users">${rows}</div>`;
}

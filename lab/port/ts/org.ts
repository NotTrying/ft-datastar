// Organizations, members and invitations. Ported from
// src/lib/server/org-bootstrap.ts and dashboard/settings/organization.
//
// Worth noting what moved: in the SvelteKit original every mutation here is a
// CLIENT-side RPC call (authClient.organization.create / inviteMember /
// removeMember / cancelInvitation / setActive) against better-auth's
// /api/auth/org/* endpoints. Under Datastar they are ordinary server routes,
// so the browser makes no API calls of its own and holds no org state.
import { esc } from "./render.ts";
import type { Store, MemberRow, InviteRow, OrgRow } from "./store.ts";

export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const id = (p: string) => `${p}_${crypto.randomUUID().replaceAll("-", "")}`;

/**
 * Create the personal organization and owner membership for a new user.
 *
 * The slug (`personal-<first 12 of user id>`) is UNIQUE, so a second call for
 * the same user rejects and nobody ends up with two personal orgs.
 */
export function createPersonalOrg(
  store: Store, user: { id: string; name?: string | null; email: string },
): string {
  const orgId = id("org");
  const display = (user.name || user.email.split("@")[0]!).trim();
  const slug = `personal-${user.id.slice(0, 12)}`.toLowerCase();
  store.createOrg(orgId, `${display}'s workspace`, slug);
  try {
    store.addMember(id("mem"), orgId, user.id, "owner");
  } catch (err) {
    // No cross-await transaction here (D1 has none either), so clean up the
    // parent row by hand. Without this the orphaned org's UNIQUE slug — derived
    // from the user id — would make every future retry reject, and the user
    // could never get an org at all.
    store.deleteOrg(orgId);
    throw err;
  }
  return orgId;
}

/** Idempotent: called on every sign-in, does nothing if they already have one. */
export function ensurePersonalOrg(
  store: Store, user: { id: string; name?: string | null; email: string },
): string {
  const existing = store.orgsFor(user.id);
  return existing.length ? existing[0]!.id : createPersonalOrg(store, user);
}

// ---------- permissions ----------

export const canManage = (role: string | null) => role === "owner" || role === "admin";

export function validateInvite(
  store: Store, orgId: string, rawEmail: string, role: string,
): { ok: true; email: string; role: Role } | { ok: false; error: string } {
  const email = (rawEmail ?? "").trim().toLowerCase();
  if (!email || !EMAIL_REGEX.test(email)) return { ok: false, error: "Valid email is required" };
  if (!(ROLES as readonly string[]).includes(role)) return { ok: false, error: "Unknown role" };
  if (role === "owner") return { ok: false, error: "An organisation has one owner" };

  if (store.members(orgId).some((m) => m.email === email))
    return { ok: false, error: "That person is already a member" };
  if (store.inviteByEmail(orgId, email))
    return { ok: false, error: "They already have a pending invitation" };

  return { ok: true, email, role: role as Role };
}

export const inviteExpiry = () => Date.now() + INVITE_TTL_MS;

// ---------- rendering ----------

export const renderOrgMsg = (kind: "" | "ok" | "err", text = "") =>
  kind === "" ? `<div id="org-msg"></div>`
  : `<div id="org-msg"><div class="alert ${kind}" role="${kind === "ok" ? "status" : "alert"}">${text}</div></div>`;

export function renderOrgSwitcher(orgs: OrgRow[], activeId: string | null): string {
  if (orgs.length <= 1) return `<div id="org-switcher"></div>`;
  return `<div id="org-switcher" class="row" style="margin-bottom:14px">` +
    orgs.map((o) =>
      `<button class="btn sm${o.id === activeId ? " primary" : ""}" ` +
      `data-on:click="@post('/org/active?id=${esc(o.id)}')">${esc(o.name)}</button>`).join("") +
    `</div>`;
}

export function renderMembers(
  members: MemberRow[], activeId: string, viewerId: string, viewerRole: string | null,
): string {
  const manage = canManage(viewerRole);
  const rows = members.map((m) => {
    const isSelf = m.user_id === viewerId;
    const removable = manage && m.role !== "owner" && !isSelf;
    return `<article class="t member"><div class="who"><div class="av">` +
      `${esc((m.name || m.email)[0]!.toUpperCase())}</div><div>` +
      `<div class="meta"><span class="name">${esc(m.name || m.email)}</span>` +
      `<span class="plat">${esc(m.role)}</span>` +
      (isSelf ? `<span class="muted small">you</span>` : "") + `</div>` +
      `<div class="foot"><span>${esc(m.email)}</span></div>` +
      `</div></div><div class="acts">` +
      (removable
        ? `<button class="btn sm danger" data-on:click="@delete('/org/members/${esc(m.user_id)}')">Remove</button>`
        : `<span class="muted small">${m.role === "owner" ? "owner" : isSelf ? "—" : ""}</span>`) +
      `</div></article>`;
  }).join("");
  return `<div id="members">${rows}</div>`;
}

export function renderInvites(invites: InviteRow[], viewerRole: string | null, origin: string): string {
  if (!invites.length)
    return `<div id="invites"><p class="muted small">No pending invitations.</p></div>`;
  const manage = canManage(viewerRole);
  return `<div id="invites">` + invites.map((i) =>
    `<article class="t invite"><div class="who"><div>` +
    `<div class="meta"><span class="name">${esc(i.email)}</span>` +
    `<span class="plat">${esc(i.role)}</span></div>` +
    `<div class="foot"><span>Expires ${esc(new Date(i.expires_at).toLocaleDateString("en-US",
      { month: "short", day: "numeric" }))}</span>` +
    `<code class="mono">${esc(origin)}/invite/${esc(i.id)}</code></div>` +
    `</div></div><div class="acts">` +
    (manage
      ? `<button class="btn sm danger" data-on:click="@delete('/org/invites/${esc(i.id)}')">Cancel</button>`
      : "") +
    `</div></article>`).join("") + `</div>`;
}

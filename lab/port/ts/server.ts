// Datastar port of the social-proof dashboard. Web-standard fetch handler,
// SQLite for storage, SSE for every update. No framework, no build step.
import { readFile } from "node:fs/promises";
import { Store, STATUSES, Duplicate, type Status } from "./store.ts";
import { validateManualTestimonial } from "./validate.ts";
import { renderStats, renderTabs, renderList, renderMsg, esc } from "./render.ts";
import { canUse, limitsFor, validateHandle, renderHandles, renderHandleMsg, renderPlan } from "./handles.ts";
import { searchMentions, scanRow } from "./scan.ts";
import { generateWallId, parseDomainInput, parseAllowedDomains, isOriginAllowed, parseCssVars } from "./walls.ts";
import { renderWalls, renderWallMsg, renderWallHtml, embedHeaders, applyOverrides } from "./embed.ts";
import {
  validateProfile, issueOtp, checkOtp, clearOtp, lastOtp,
  renderProfile, renderSessions, renderMsg as renderSettingsMsg,
} from "./settings.ts";
import {
  ensurePersonalOrg, canManage, validateInvite, inviteExpiry,
  renderOrgMsg, renderOrgSwitcher, renderMembers, renderInvites,
} from "./org.ts";
import {
  COOKIE, SESSION_TTL_MS, hashPassword, verifyPassword, tokenHash, newToken,
  sessionCookie, clearCookie, readCookie, isDatastar, sameOrigin, sseRedirect,
  currentUser, requireUser,
} from "./auth.ts";

const SHARED = process.env.LAB_SHARED ?? "../shared";
const store = new Store(process.env.LAB_DB ?? "social-proof.db");

// ---------- SSE ----------

class SSE {
  private enc = new TextEncoder();
  constructor(private c: ReadableStreamDefaultController) {}
  patch(elems: string, ...opts: string[]) {
    let out = "event: datastar-patch-elements\n";
    for (const o of opts) out += `data: ${o}\n`;
    // One `data: elements ` line per line of HTML — required by the spec.
    for (const line of elems.replace(/\n+$/, "").split("\n")) out += `data: elements ${line}\n`;
    this.c.enqueue(this.enc.encode(out + "\n"));
  }
  signals(json: string) {
    this.c.enqueue(this.enc.encode(`event: datastar-patch-signals\ndata: signals ${json}\n\n`));
  }
}

// Unlike a Go http.ResponseWriter, a Response is constructed with its headers,
// so there is no way to start the stream before setting a cookie. The
// header-ordering bug the Go port hit is unrepresentable here.
const stream = (fn: (s: SSE) => void | Promise<void>, headers: Record<string, string> = {}) =>
  new Response(new ReadableStream({
    async start(c) { const s = new SSE(c); try { await fn(s); } finally { try { c.close(); } catch {} } },
  }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function redraw(s: SSE, uid: string, tab: Status) {
  const c = store.counts(uid);
  s.patch(renderStats(c));
  s.patch(renderTabs(c, tab));
  s.patch(renderList(store.list(uid, tab), tab, store.total(uid)));
}

// ---------- signals in ----------

async function readSignals(req: Request, url: URL) {
  const raw = url.searchParams.get("datastar") ?? (req.body ? await req.text() : "");
  let o: Record<string, string> = {};
  if (raw) { try { o = JSON.parse(raw); } catch { /* malformed: treat as empty */ } }
  const tab = (STATUSES as string[]).includes(o.tab ?? "") ? (o.tab as Status) : "pending";
  return { tab, input: o };
}

const file = async (path: string, type: string) =>
  new Response(await readFile(path), { headers: { "content-type": type } });

async function page(name: string, subs: Record<string, string> = {}) {
  let out = (await readFile(`${SHARED}/${name}`, "utf8")).replaceAll("__BACKEND__", "TypeScript");
  for (const [k, v] of Object.entries(subs)) out = out.replace(k, v);
  return new Response(out, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// ---------- routes ----------

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const secure = url.protocol === "https:";

  // ---- public ----
  if (p === "/datastar.js") return file(`${SHARED}/datastar.js`, "text/javascript; charset=utf-8");
  if (p === "/styles.css") return file(`${SHARED}/styles.css`, "text/css; charset=utf-8");
  if (p === "/favicon.ico") return new Response(null, { status: 204 });

  if (p === "/login" && req.method === "GET") {
    if (await currentUser(store, req))
      return new Response(null, { status: 302, headers: { location: "/" } });
    return page("login.html");
  }

  // contentType:'form' means the password arrives as a form field, never as a
  // signal. See the comment at the top of shared/login.html.
  if (p === "/login" && req.method === "POST") {
    if (!isDatastar(req) || !sameOrigin(req)) return new Response("forbidden", { status: 403 });
    const form = await req.formData();
    const email = String(form.get("email") ?? "");
    const row = store.findUser(email);
    // Hash regardless so a missing account and a wrong password take the same
    // time — otherwise the response time enumerates registered emails.
    const good = await verifyPassword(String(form.get("password") ?? ""),
      row?.pw_hash ?? "$argon2id$v=19$m=65536,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    if (!row || !good)
      // One message for both cases: saying which half was wrong enumerates accounts.
      return stream((s) => s.patch(
        `<div id="login-msg"><div class="alert err" role="alert">That email and password do not match.</div></div>`));

    const tok = newToken();
    const expires = new Date(Date.now() + SESSION_TTL_MS);
    const hash = await tokenHash(tok);
    store.createSession(hash, row.id, expires,
      (req.headers.get("user-agent") ?? "").slice(0, 120));
    // Everyone gets a personal workspace on first sign-in, and the new session
    // starts in it. Idempotent, so later sign-ins reuse the existing one.
    const u = store.userById(row.id)!;
    store.setActiveOrg(hash, ensurePersonalOrg(store, u));
    return sseRedirect("/", { "set-cookie": sessionCookie(tok, expires, secure) });
  }

  if (p === "/logout" && req.method === "POST") {
    const tok = readCookie(req, COOKIE);
    if (tok) store.dropSession(await tokenHash(tok));
    const headers = { "set-cookie": clearCookie() };
    return isDatastar(req)
      ? sseRedirect("/login", headers)
      : new Response(null, { status: 302, headers: { ...headers, location: "/login" } });
  }

  // ---- public: anonymous visitors on someone else's website ----

  const em = p.match(/^\/embed\/([^/]+)$/);
  if (em && req.method === "GET") {
    const found = store.loadWall(decodeURIComponent(em[1]!));
    // An unknown or disabled wall gets a 404 the browser renders as an empty
    // frame. The customer's page shows nothing rather than our error.
    if (!found) return new Response("Not found", { status: 404 });
    const w = applyOverrides(found.wall, url.searchParams);
    const items = store.loadWallItems(found.ownerId, w.max_items);
    // Per-request nonce: it is what allows the single inline stylesheet and
    // the single height script to run under an otherwise empty CSP.
    const nonce = crypto.randomUUID().replaceAll("-", "");
    return new Response(renderWallHtml(w, items, nonce),
      { headers: embedHeaders(nonce, parseAllowedDomains(w.allowed_domains)) });
  }

  const am = p.match(/^\/api\/v1\/walls\/([^/]+)$/);
  if (am && req.method === "GET") {
    const found = store.loadWall(decodeURIComponent(am[1]!));
    if (!found) return new Response(`{"error":"not found"}`, { status: 404 });
    const allowed = parseAllowedDomains(found.wall.allowed_domains);
    const origin = req.headers.get("origin");
    if (!isOriginAllowed(origin, allowed))
      return new Response(`{"error":"origin not allowed"}`, { status: 403 });
    const headers: Record<string, string> = {
      "content-type": "application/json", "cache-control": "public, max-age=60",
    };
    if (origin) { headers["access-control-allow-origin"] = origin; headers["vary"] = "Origin"; }
    else if (allowed === null) headers["access-control-allow-origin"] = "*";
    const w = found.wall;
    const items = store.loadWallItems(found.ownerId, w.max_items).map((it) => ({
      id: it.id, platform: it.platform, content: it.content, url: it.post_url,
      author: { handle: it.author_handle, name: it.author_name }, postedAt: it.posted_at,
    }));
    return new Response(JSON.stringify({
      wall: { id: w.id, layout: w.layout, theme: w.theme, density: w.density,
              showDates: !!w.show_dates, cssVars: parseCssVars(w.css_vars) },
      items,
    }), { headers });
  }

  // ---- protected ----
  return requireUser(store, req, async (uid) => {
    if (p === "/" && req.method === "GET") {
      const c = store.counts(uid);
      return page("dashboard.html", {
        __EMAIL__: esc(store.emailFor(uid)),
        __STATS__: renderStats(c),
        __TABS__: renderTabs(c, "pending"),
        __LIST__: renderList(store.list(uid, "pending"), "pending", store.total(uid)),
      });
    }

    const { tab, input } = await readSignals(req, url);
    const origin = process.env.LAB_ORIGIN ?? url.origin;

    // ---- walls (dashboard) ----

    if (p === "/walls" && req.method === "GET")
      return page("walls.html", {
        __EMAIL__: esc(store.emailFor(uid)),
        __WALLS__: renderWalls(store.listWalls(uid), origin),
      });

    if (p === "/walls" && req.method === "POST") {
      const name = String(input.wallName ?? "").trim();
      if (!name || [...name].length > 60)
        return stream((s) => s.patch(renderWallMsg("err", "Give the wall a name of up to 60 characters.")));
      const id = generateWallId();
      store.createWall(id, uid, name);
      return stream((s) => {
        s.patch(renderWallMsg("ok", `Wall <code class="mono">${esc(id)}</code> created. Paste the snippet into your site.`));
        s.signals(`{wallName: ''}`);
        s.patch(renderWalls(store.listWalls(uid), origin));
      });
    }

    // ---- organisation ----

    const sessionHash = async () => {
      const t = readCookie(req, COOKIE);
      return t ? await tokenHash(t) : "";
    };
    // The session's active org is only honoured while the user is still a
    // member of it. Without this check a removed member keeps reading the org
    // they were removed from, because their session still points at it.
    const activeOrgFor = async (hash: string) => {
      const pinned = store.activeOrg(hash);
      if (pinned && store.roleIn(pinned, uid)) return pinned;
      const fallback = store.orgsFor(uid)[0]?.id ?? null;
      if (pinned !== fallback) store.setActiveOrg(hash, fallback);
      return fallback;
    };

    if (p.startsWith("/org")) {
      const hash = await sessionHash();
      const orgId = await activeOrgFor(hash);
      const role = orgId ? store.roleIn(orgId, uid) : null;

      if (p === "/org" && req.method === "GET") {
        const orgs = store.orgsFor(uid);
        const org = orgId ? store.org(orgId) : null;
        const inviteForm = canManage(role)
          ? `<form data-on:submit__prevent="@post('/org/invites')" data-indicator:_busy>
               <div class="row">
                 <label class="grow"><span>Email</span>
                   <input type="email" data-bind:invite-email placeholder="colleague@example.com"></label>
                 <label><span>Role</span>
                   <select data-bind:invite-role>
                     <option value="member">member</option><option value="admin">admin</option>
                   </select></label>
                 <button type="submit" class="btn primary" data-attr:disabled="$_busy || !$inviteEmail"
                         data-text="$_busy ? 'Inviting…' : 'Send invite'">Send invite</button>
               </div></form>`
          : `<p class="muted small">Only an owner or admin can invite people.</p>`;
        return page("org.html", {
          __EMAIL__: esc(store.userById(uid)!.email),
          __ORGNAME__: esc(org?.name ?? "No organisation"),
          __SWITCHER__: renderOrgSwitcher(orgs, orgId),
          __MEMBERS__: orgId ? renderMembers(store.members(orgId), orgId, uid, role) : `<div id="members"></div>`,
          __INVITEFORM__: inviteForm,
          __INVITES__: orgId ? renderInvites(store.pendingInvites(orgId), role, origin) : `<div id="invites"></div>`,
        });
      }

      const redraw = (s: SSE, oid: string, r: string | null) => {
        s.patch(renderMembers(store.members(oid), oid, uid, r));
        s.patch(renderInvites(store.pendingInvites(oid), r, origin));
        s.patch(renderOrgSwitcher(store.orgsFor(uid), oid));
      };

      if (p === "/org" && req.method === "POST") {
        const name = String(input.orgName ?? "").trim();
        if (!name || name.length > 80)
          return stream((s) => s.patch(renderOrgMsg("err", "Give the organisation a name of up to 80 characters.")));
        const newId = `org_${crypto.randomUUID().replaceAll("-", "")}`;
        try {
          store.createOrg(newId, name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${newId.slice(4, 12)}`);
          store.addMember(`mem_${crypto.randomUUID().replaceAll("-", "")}`, newId, uid, "owner");
        } catch {
          return stream((s) => s.patch(renderOrgMsg("err", "Could not create that organisation.")));
        }
        store.setActiveOrg(hash, newId);
        // The whole page changes identity, so send the browser back to it.
        return sseRedirect("/org");
      }

      if (p === "/org/active" && req.method === "POST") {
        const target = url.searchParams.get("id") ?? "";
        // Switching is only legal into an org you actually belong to.
        if (!store.roleIn(target, uid)) return new Response("not a member", { status: 403 });
        store.setActiveOrg(hash, target);
        return sseRedirect("/org");
      }

      if (!orgId) return new Response("no active organisation", { status: 400 });

      if (p === "/org/invites" && req.method === "POST") {
        if (!canManage(role)) return new Response("forbidden", { status: 403 });
        const v = validateInvite(store, orgId, String(input.inviteEmail ?? ""), String(input.inviteRole ?? "member"));
        if (!v.ok) return stream((s) => s.patch(renderOrgMsg("err", esc(v.error))));
        const inviteId = `inv_${crypto.randomUUID().replaceAll("-", "")}`;
        store.createInvite(inviteId, orgId, v.email, v.role, uid, inviteExpiry());
        console.log(`[email] invitation ${origin}/invite/${inviteId} -> ${v.email}`);
        return stream((s) => {
          s.patch(renderOrgMsg("ok", `Invitation sent to ${esc(v.email)}.`));
          s.signals(`{inviteEmail: ''}`);
          redraw(s, orgId, role);
        });
      }

      const im = p.match(/^\/org\/invites\/([^/]+)$/);
      if (im && req.method === "DELETE") {
        if (!canManage(role)) return new Response("forbidden", { status: 403 });
        const inv = store.invite(decodeURIComponent(im[1]!));
        // Scoped to this org: an id from another org must not be cancellable.
        if (!inv || inv.organization_id !== orgId) return new Response("not found", { status: 404 });
        store.setInviteStatus(inv.id, "cancelled");
        return stream((s) => {
          s.patch(renderOrgMsg("ok", "Invitation cancelled."));
          redraw(s, orgId, role);
        });
      }

      const mm = p.match(/^\/org\/members\/([^/]+)$/);
      if (mm && req.method === "DELETE") {
        if (!canManage(role)) return new Response("forbidden", { status: 403 });
        const target = decodeURIComponent(mm[1]!);
        const targetRole = store.roleIn(orgId, target);
        if (!targetRole) return new Response("not found", { status: 404 });
        // The owner is not removable, and nobody removes themselves here.
        if (targetRole === "owner") return new Response("the owner cannot be removed", { status: 400 });
        if (target === uid) return new Response("use leave instead", { status: 400 });
        store.removeMember(orgId, target);
        return stream((s) => {
          s.patch(renderOrgMsg("ok", "Member removed."));
          redraw(s, orgId, role);
        });
      }
    }

    // ---- invitations (the invitee's side) ----

    const invm = p.match(/^\/invite\/([^/]+)$/);
    if (invm && req.method === "GET") {
      const inv = store.invite(decodeURIComponent(invm[1]!));
      const me = store.userById(uid)!;
      let body: string;
      if (!inv || inv.status !== "pending" || inv.expires_at < Date.now()) {
        body = `<p class="muted">Invitation not found or has expired.</p>`;
      } else if (inv.email !== me.email) {
        // Say who it is for, so a signed-in visitor knows to switch accounts.
        body = `<p>This invitation is for <strong>${esc(inv.email)}</strong>, ` +
          `but you are signed in as <strong>${esc(me.email)}</strong>.</p>`;
      } else {
        body = `<p>You have been invited to join <strong>${esc(inv.org_name)}</strong> ` +
          `as <strong>${esc(inv.role)}</strong>.</p>
          <div class="row">
            <button class="btn primary" data-on:click="@post('/invite/${esc(inv.id)}/accept')">Accept</button>
            <button class="btn" data-on:click="@post('/invite/${esc(inv.id)}/decline')">Decline</button>
          </div>`;
      }
      return page("invite.html", { __INVITE__: `<div id="invite-body">${body}</div>` });
    }

    const acc = p.match(/^\/invite\/([^/]+)\/(accept|decline)$/);
    if (acc && req.method === "POST") {
      const inv = store.invite(decodeURIComponent(acc[1]!));
      const me = store.userById(uid)!;
      if (!inv || inv.status !== "pending" || inv.expires_at < Date.now())
        return stream((s) => s.patch(`<div id="invite-body"><p class="muted">That invitation is no longer valid.</p></div>`));
      // An invitation is addressed to one email; anyone else is refused.
      if (inv.email !== me.email) return new Response("not your invitation", { status: 403 });

      if (acc[2] === "decline") {
        store.setInviteStatus(inv.id, "rejected");
        return stream((s) => s.patch(`<div id="invite-body"><p class="muted">Invitation declined.</p></div>`));
      }
      store.setInviteStatus(inv.id, "accepted");
      try {
        store.addMember(`mem_${crypto.randomUUID().replaceAll("-", "")}`, inv.organization_id, uid, inv.role);
      } catch { /* already a member: accepting twice is harmless */ }
      store.setActiveOrg(await sessionHash(), inv.organization_id);
      return sseRedirect("/org");
    }

    // ---- settings ----

    const settingsPage = async () => {
      const u = store.userById(uid)!;
      const tok = readCookie(req, COOKIE);
      const hash = tok ? await tokenHash(tok) : "";
      return page("settings.html", {
        __EMAIL__: esc(u.email),
        __PROFILE__: renderProfile(u),
        __SESSIONS__: renderSessions(store.listSessions(uid), hash),
      });
    };

    if (p === "/settings" && req.method === "GET") return settingsPage();

    if (p === "/settings/profile" && req.method === "POST") {
      const u = store.userById(uid)!;
      const v = validateProfile({ name: String(input.name ?? ""), email: String(input.email ?? "") });
      if (!v.ok) return stream((s) => s.patch(renderSettingsMsg("err", esc(v.error))));

      // The name is saved immediately either way, matching the original.
      store.setUserName(uid, v.name);

      if (v.email === u.email) {
        return stream((s) => {
          s.patch(renderSettingsMsg("ok", "Profile updated successfully"));
          s.patch(renderProfile({ ...u, name: v.name }));
        });
      }
      const taken = store.findUser(v.email);
      if (taken && taken.id !== uid)
        return stream((s) => s.patch(renderSettingsMsg("err", "Email is already taken")));

      // Step 1: prove you still control the CURRENT address.
      issueOtp(uid, "current", u.email, v.email);
      return stream((s) => {
        s.patch(renderSettingsMsg("ok",
          `Verification code sent to your current email (${esc(u.email)}). Enter it below to confirm it&rsquo;s you.`));
        s.patch(renderProfile({ ...u, name: v.name }, "current", v.email));
      });
    }

    if (p === "/settings/verify-current" && req.method === "POST") {
      const u = store.userById(uid)!;
      const hit = checkOtp(uid, "current", String(input.otp ?? ""));
      if (!hit)
        return stream((s) => s.patch(renderSettingsMsg("err",
          "Invalid or expired verification code. Please try again.")));
      // Step 2: now prove you own the NEW address.
      issueOtp(uid, "new", hit.pendingEmail, hit.pendingEmail);
      return stream((s) => {
        s.patch(renderSettingsMsg("ok",
          `Current email verified. A code has been sent to ${esc(hit.pendingEmail)}.`));
        s.patch(renderProfile(u, "new", hit.pendingEmail));
        s.signals(`{otp: ''}`);
      });
    }

    if (p === "/settings/verify-new" && req.method === "POST") {
      const hit = checkOtp(uid, "new", String(input.otp ?? ""));
      if (!hit)
        return stream((s) => s.patch(renderSettingsMsg("err",
          "Invalid or expired verification code. Please try again.")));
      // Step 3: commit.
      store.setUserEmail(uid, hit.pendingEmail);
      clearOtp(uid);
      const u = store.userById(uid)!;
      return stream((s) => {
        s.patch(renderSettingsMsg("ok", "Email address updated successfully"));
        s.patch(renderProfile(u));
        s.signals(`{otp: '', email: '${u.email}'}`);
      });
    }

    if (p === "/settings/cancel-email" && req.method === "POST") {
      clearOtp(uid);
      const u = store.userById(uid)!;
      return stream((s) => {
        s.patch(renderSettingsMsg(""));
        s.patch(renderProfile(u));
        s.signals(`{otp: ''}`);
      });
    }

    const sm = p.match(/^\/settings\/sessions\/([0-9a-f]{64})$/);
    if (sm && req.method === "DELETE") {
      const tok = readCookie(req, COOKIE);
      const hash = tok ? await tokenHash(tok) : "";
      const target = sm[1]!;
      // Revoking your own current session would sign you out mid-request.
      if (target === hash) return new Response("cannot revoke the current session", { status: 400 });
      if (!store.revokeSession(uid, target)) return new Response("not found", { status: 404 });
      return stream((s) => {
        s.patch(renderSettingsMsg("ok", "Session revoked successfully"));
        s.patch(renderSessions(store.listSessions(uid), hash));
      });
    }

    if (p === "/settings/revoke-others" && req.method === "POST") {
      const tok = readCookie(req, COOKIE);
      const hash = tok ? await tokenHash(tok) : "";
      const n = store.revokeOtherSessions(uid, hash);
      return stream((s) => {
        s.patch(renderSettingsMsg("ok", `All other sessions revoked (${n})`));
        s.patch(renderSessions(store.listSessions(uid), hash));
      });
    }

    // Dev-only: lets the browser suite read the OTP the mock mailer "sent".
    // Gated on LAB_DEV_OTP=1, which no normal run sets.
    if (p === "/dev/last-otp" && process.env.LAB_DEV_OTP === "1")
      return new Response(JSON.stringify(lastOtp ?? {}), { headers: { "content-type": "application/json" } });

    const wm = p.match(/^\/walls\/([^/]+)$/);
    if (wm) {
      const id = decodeURIComponent(wm[1]!);
      if (req.method === "PATCH") {
        const enabled = url.searchParams.get("enabled");
        if (enabled !== null && !store.setWallEnabled(uid, id, enabled === "true"))
          return new Response("not found", { status: 404 });
        if (url.searchParams.has("domains")) {
          // null (blank input) means unrestricted; that distinction is
          // load-bearing in isOriginAllowed.
          if (!store.setWallDomains(uid, id, parseDomainInput(url.searchParams.get("domains") ?? "")))
            return new Response("not found", { status: 404 });
        }
        return stream((s) => s.patch(renderWalls(store.listWalls(uid), origin)));
      }
      if (req.method === "DELETE") {
        if (!store.deleteWall(uid, id)) return new Response("not found", { status: 404 });
        return stream((s) => {
          s.patch(renderWallMsg("ok", "Wall deleted."));
          s.patch(renderWalls(store.listWalls(uid), origin));
        });
      }
    }

    // A GET, and deliberately read-only: a GET is a CORS-simple request, so
    // anything that mutates must not be reachable by one.
    if (p === "/testimonials" && req.method === "GET") return stream((s) => redraw(s, uid, tab));

    if (p === "/testimonials" && req.method === "POST") {
      const result = validateManualTestimonial(input);
      if (!result.ok) return stream((s) => s.patch(renderMsg("err", esc(result.error))));
      try {
        store.insert(uid, crypto.randomUUID(), result.row);
      } catch (e) {
        const msg = e instanceof Duplicate
          ? "You have already added that one." : "Could not save that. Try again.";
        return stream((s) => s.patch(renderMsg("err", msg)));
      }
      return stream((s) => {
        s.patch(renderMsg("ok", "Added. It is waiting in <strong>Pending</strong> for you to approve."));
        s.signals(`{content: '', authorName: '', authorHandle: '', sourceUrl: '', postedAt: '', tab: 'pending'}`);
        redraw(s, uid, "pending");
      });
    }

    // ---- handles ----

    if (p === "/handles" && req.method === "GET") {
      const lim = limitsFor(store.planFor(uid));
      return page("handles.html", {
        __EMAIL__: esc(store.emailFor(uid)),
        __PLAN__: renderPlan(store.countHandles(uid), lim),
        __HANDLES__: renderHandles(store.listHandles(uid)),
      });
    }

    if (p === "/handles" && req.method === "POST") {
      const v = validateHandle(String(input.handle ?? ""));
      if (!v.ok) return stream((s) => s.patch(renderHandleMsg("err", esc(v.error))));
      const lim = limitsFor(store.planFor(uid));
      if (!canUse(lim.maxHandles, store.countHandles(uid)))
        return stream((s) => s.patch(renderHandleMsg("err",
          "Handle limit reached. Upgrade your plan to monitor more handles.")));
      try {
        store.addHandle(uid, v.handle);
      } catch (e) {
        const msg = e instanceof Duplicate
          ? "You are already monitoring this handle" : "Could not add that handle. Try again.";
        return stream((s) => s.patch(renderHandleMsg("err", msg)));
      }
      return stream((s) => {
        s.patch(renderHandleMsg("ok", `Now monitoring @${esc(v.handle)}.`));
        s.signals(`{handle: ''}`);
        s.patch(renderPlan(store.countHandles(uid), lim));
        s.patch(renderHandles(store.listHandles(uid)));
      });
    }

    const hm = p.match(/^\/handles\/([^/]+)$/);
    if (hm && req.method === "DELETE") {
      if (!store.deleteHandle(uid, decodeURIComponent(hm[1]!)))
        return new Response("not found", { status: 404 });
      const lim = limitsFor(store.planFor(uid));
      return stream((s) => {
        s.patch(renderHandleMsg("ok", "Handle removed."));
        s.patch(renderPlan(store.countHandles(uid), lim));
        s.patch(renderHandles(store.listHandles(uid)));
      });
    }

    // POST, not GET: a GET is a CORS-simple request, and this mutates.
    if (p === "/scan" && req.method === "POST") {
      const h = store.handleById(uid, url.searchParams.get("id") ?? "");
      if (!h) return new Response("handle not found", { status: 404 });
      const lim = limitsFor(store.planFor(uid));

      return stream(async (s) => {
        // The whole panel is replaced first so a repeat scan starts clean.
        s.patch(`<div id="scan-panel"><div id="scan-status" class="muted small">Starting…</div>` +
          `<div id="scan-feed" class="scan-feed"></div><div id="scan-summary"></div></div>`);
        s.signals(`{_scanning: true}`);
        try {
          if (!canUse(lim.scansPerMonth, store.scansThisMonth(uid))) {
            s.patch(`<div id="scan-status" class="alert err">Monthly scan limit reached. ` +
              `Upgrade your plan for more scans.</div>`);
            return;
          }
          store.logScan(uid, h.id);
          const step = (msg: string) =>
            s.patch(`<div id="scan-status" class="muted small">${esc(msg)}</div>`);

          step(`Searching X for mentions of @${h.handle}…`);
          await sleep(500);
          if (req.signal?.aborted) return;

          const { mentions, newestId } = searchMentions(h.handle, h.last_post_id);
          const known = store.knownPostIds(uid, "x");
          let stored = store.total(uid);
          step(`Found ${mentions.length} mentions. Checking them against what you already have…`);

          let added = 0, skippedDupe = 0, skippedCap = 0;
          for (const [i, m] of mentions.entries()) {
            await sleep(320);
            if (req.signal?.aborted) return; // the user navigated away; stop scanning

            let verdict: string, cls: string;
            if (known.has(m.postId)) { verdict = "already stored"; cls = "dupe"; skippedDupe++; }
            else if (!canUse(lim.maxTestimonials, stored)) {
              // Insert up to the remaining room and report the rest as
              // skipped, rather than failing the whole scan.
              verdict = "over plan cap"; cls = "capped"; skippedCap++;
            } else {
              try { store.insertScanned(uid, h.id, m); verdict = "added to Pending"; cls = "new"; added++; stored++; }
              catch { verdict = "already stored"; cls = "dupe"; skippedDupe++; }
            }

            // mode append: each row joins the feed as it is decided.
            s.patch(scanRow(m, verdict, cls), "selector #scan-feed", "mode append");
            s.patch(`<div id="scan-status" class="muted small">Checked ${i + 1} of ${mentions.length}…` +
              `<div class="bar"><i style="width:${((i + 1) * 100) / mentions.length}%"></i></div></div>`);
          }

          store.touchHandle(h.id, newestId);
          let summary = `${mentions.length} found &middot; ${added} new &middot; ${skippedDupe} already stored`;
          if (skippedCap > 0) summary += ` &middot; ${skippedCap} skipped (plan cap)`;
          s.patch(`<div id="scan-status" class="muted small">Done.</div>`);
          s.patch(`<div id="scan-summary"><div class="alert ok" role="status">${summary}</div></div>`);
          s.patch(renderHandles(store.listHandles(uid)));
        } finally {
          s.signals(`{_scanning: false}`);
        }
      });
    }

    const m = p.match(/^\/testimonials\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (req.method === "PATCH") {
        const status = url.searchParams.get("status");
        if (status !== "approved" && status !== "dismissed")
          return new Response('status must be "approved" or "dismissed"', { status: 400 });
        if (!store.setStatus(uid, id, status)) return new Response("not found", { status: 404 });
        return stream((s) => redraw(s, uid, tab));
      }
      if (req.method === "DELETE") {
        if (!store.remove(uid, id)) return new Response("not found", { status: 404 });
        return stream((s) => redraw(s, uid, tab));
      }
    }
    return new Response("not found", { status: 404 });
  });
}

// Sample rows so the dashboard has something to show. Mirrors the mock X data
// the SvelteKit app ships in src/lib/server/sources/x.ts.
async function seed(): Promise<string> {
  let user = store.findUser("owner@example.com");
  if (!user) {
    const id = crypto.randomUUID();
    store.createUser(id, "owner@example.com", await hashPassword("correct-horse-battery"), "Sam Owner");
    user = store.findUser("owner@example.com")!;
  }
  // Pro so the handle and testimonial caps are exercised but not in the way.
  store.setPlan(user.id, "pro");
  try { store.addHandle(user.id, "acmetools"); } catch { /* already there */ }
  // A second account, so the "email is already taken" path is reachable.
  if (!store.findUser("other@example.com"))
    store.createUser(crypto.randomUUID(), "other@example.com",
      await hashPassword("correct-horse-battery"), "Other Person");
  if (store.total(user.id) > 0) return user.id;
  const d = (s: string) => new Date(s);
  const rows: [string, string, string, string, string, string, Date, Status][] = [
    ["x", "https://x.com/janes/status/1", "janesmith", "Jane Smith", "Sold our house in nine days and answered the phone every time.", "scan", d("2026-07-14"), "pending"],
    ["x", "https://x.com/dmr/status/2", "dmreid", "Danielle Reid", "Booked them twice now. Turned up when they said they would, which is the whole job.", "scan", d("2026-07-02"), "pending"],
    ["google", "https://g.page/r/demo/review/3", "", "Marcus Bell", "Quoted honestly, finished early, cleaned up after themselves.", "manual", d("2026-06-21"), "approved"],
    ["trustpilot", "https://trustpilot.com/reviews/4", "", "Priya N.", "Third time using them. No notes.", "manual", d("2026-05-30"), "approved"],
    ["x", "https://x.com/spam/status/5", "linkfarm22", "", "check out my crypto course link in bio", "scan", d("2026-06-01"), "dismissed"],
  ];
  for (const [platform, urlStr, handle, name, content, source, postedAt, status] of rows) {
    store.insert(user.id, crypto.randomUUID(), {
      source: source as "manual", platform, postId: urlStr, postUrl: urlStr,
      authorHandle: handle || null, authorName: name || null, content, postedAt,
    }, status);
  }
  return user.id;
}
await seed();

const port = Number(process.env.PORT ?? 8083);
console.log(`social-proof (Datastar/TypeScript) on http://localhost:${port}`);
export default { port, fetch: handle };

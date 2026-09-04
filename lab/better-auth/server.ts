// Datastar + better-auth. The migration experiment.
//
// What is being tested: whether better-auth's handler and API coexist with
// Datastar's SSE responses on a plain Web-standard fetch handler — the shape
// social-proof would actually migrate to.
import { readFile } from "node:fs/promises";
import { auth } from "./auth.ts";

const SHARED = process.env.LAB_SHARED ?? "./shared";
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// ---------- SSE ----------

class SSE {
  private enc = new TextEncoder();
  constructor(private c: ReadableStreamDefaultController) {}
  patch(elems: string, ...opts: string[]) {
    let out = "event: datastar-patch-elements\n";
    for (const o of opts) out += `data: ${o}\n`;
    for (const line of elems.replace(/\n+$/, "").split("\n")) out += `data: elements ${line}\n`;
    this.c.enqueue(this.enc.encode(out + "\n"));
  }
  signals(json: string) {
    this.c.enqueue(this.enc.encode(`event: datastar-patch-signals\ndata: signals ${json}\n\n`));
  }
}

/**
 * An SSE response, optionally carrying headers lifted from a better-auth
 * response. This is the crux of the integration: better-auth sets its session
 * cookie via Set-Cookie on ITS response, and Datastar needs an event stream.
 * A Response is constructed with its headers, so the two compose — the
 * header-before-stream trap that bit the Go port cannot arise here.
 */
const stream = (fn: (s: SSE) => void | Promise<void>, extra: Headers | null = null) => {
  const headers = new Headers({
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  if (extra) for (const c of extra.getSetCookie()) headers.append("set-cookie", c);
  return new Response(new ReadableStream({
    async start(c) { const s = new SSE(c); try { await fn(s); } finally { try { c.close(); } catch {} } },
  }), { headers });
};

const sseRedirect = (to: string, extra: Headers | null = null) =>
  stream((s) => s.patch(
    `<script>setTimeout(() => window.location = ${JSON.stringify(to)})</script>`,
    "selector body", "mode append"), extra);

async function page(name: string, subs: Record<string, string> = {}) {
  let out = await readFile(`${SHARED}/${name}`, "utf8");
  for (const [k, v] of Object.entries(subs)) out = out.replaceAll(k, v);
  return new Response(out, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const msg = (id: string, kind: "" | "ok" | "err", text = "") =>
  kind === "" ? `<div id="${id}"></div>`
  : `<div id="${id}"><div class="alert ${kind}" role="${kind === "ok" ? "status" : "alert"}">${text}</div></div>`;

// ---------- routes ----------

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;

  // better-auth owns this prefix entirely — one line, exactly as its docs say.
  if (p.startsWith("/api/auth/")) return auth.handler(req);

  if (p === "/datastar.js") return new Response(await readFile(`${SHARED}/datastar.js`),
    { headers: { "content-type": "text/javascript; charset=utf-8" } });
  if (p === "/styles.css") return new Response(await readFile(`${SHARED}/styles.css`),
    { headers: { "content-type": "text/css; charset=utf-8" } });
  if (p === "/favicon.ico") return new Response(null, { status: 204 });

  // The session, read server-side. Datastar pages are server-rendered, so this
  // is the only place session state is needed — the browser never sees a token.
  const session = await auth.api.getSession({ headers: req.headers });

  if (p === "/login" && req.method === "GET") {
    if (session) return new Response(null, { status: 302, headers: { location: "/" } });
    return page("login.html");
  }

  if (p === "/login" && req.method === "POST") {
    const form = await req.formData();
    try {
      // asResponse gives us better-auth's own Response, whose Set-Cookie we
      // lift onto the SSE reply. This is the whole integration in one line.
      const res = await auth.api.signInEmail({
        body: { email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") },
        asResponse: true,
      });
      if (!res.ok)
        return stream((s) => s.patch(msg("login-msg", "err", "That email and password do not match.")));
      return sseRedirect("/", res.headers);
    } catch {
      return stream((s) => s.patch(msg("login-msg", "err", "That email and password do not match.")));
    }
  }

  if (p === "/logout" && req.method === "POST") {
    const res = await auth.api.signOut({ headers: req.headers, asResponse: true });
    return sseRedirect("/login", res.headers);
  }

  // ---- protected ----
  if (!session) {
    if (req.headers.get("datastar-request") === "true") return sseRedirect("/login");
    return new Response(null, { status: 302, headers: { location: "/login" } });
  }

  const orgs = await auth.api.listOrganizations({ headers: req.headers });
  const activeId = (session.session as { activeOrganizationId?: string }).activeOrganizationId ?? null;

  const renderOrgs = () =>
    `<div id="orgs">` + (orgs.length
      ? orgs.map((o) =>
          `<article class="t"><div class="who"><div><div class="meta">` +
          `<span class="name">${esc(o.name)}</span>` +
          (o.id === activeId ? `<span class="plat">active</span>` : "") +
          `</div></div></div><div class="acts">` +
          (o.id === activeId ? `<span class="muted small">current</span>`
            : `<button class="btn sm" data-on:click="@post('/org/active?id=${esc(o.id)}')">Switch</button>`) +
          `</div></article>`).join("")
      : `<p class="muted small">No organisations yet.</p>`) + `</div>`;

  if (p === "/" && req.method === "GET")
    return page("app.html", {
      __EMAIL__: esc(session.user.email),
      __NAME__: esc(session.user.name ?? ""),
      __ORGS__: renderOrgs(),
    });

  if (p === "/org" && req.method === "POST") {
    const body = await req.text();
    const name = String((JSON.parse(body || "{}") as { orgName?: string }).orgName ?? "").trim();
    if (!name) return stream((s) => s.patch(msg("org-msg", "err", "Give the organisation a name.")));
    try {
      await auth.api.createOrganization({
        body: { name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}` },
        headers: req.headers,
      });
    } catch (e) {
      return stream((s) => s.patch(msg("org-msg", "err", esc(String(e).slice(0, 120)))));
    }
    return sseRedirect("/");
  }

  if (p === "/org/active" && req.method === "POST") {
    const res = await auth.api.setActiveOrganization({
      body: { organizationId: url.searchParams.get("id") ?? "" },
      headers: req.headers, asResponse: true,
    });
    // Switching the active org rewrites the session cookie, so its headers
    // must ride along on the redirect exactly as sign-in's do.
    return sseRedirect("/", res.headers);
  }

  if (p === "/org/invite" && req.method === "POST") {
    const body = JSON.parse((await req.text()) || "{}") as { inviteEmail?: string };
    try {
      const inv = await auth.api.createInvitation({
        body: { email: String(body.inviteEmail ?? ""), role: "member" },
        headers: req.headers,
      });
      return stream((s) => {
        s.patch(msg("org-msg", "ok", `Invitation created for ${esc(inv.email)}.`));
        s.signals(`{inviteEmail: ''}`);
      });
    } catch (e) {
      return stream((s) => s.patch(msg("org-msg", "err", esc(String(e).slice(0, 140)))));
    }
  }

  return new Response("not found", { status: 404 });
}

const port = Number(process.env.PORT ?? 8095);
console.log(`datastar + better-auth on http://localhost:${port}`);
export default { port, fetch: handle };

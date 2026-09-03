// Datastar port of the social-proof dashboard. Web-standard fetch handler,
// SQLite for storage, SSE for every update. No framework, no build step.
import { readFile } from "node:fs/promises";
import { Store, STATUSES, Duplicate, type Status } from "./store.ts";
import { validateManualTestimonial } from "./validate.ts";
import { renderStats, renderTabs, renderList, renderMsg, esc } from "./render.ts";
import { canUse, limitsFor, validateHandle, renderHandles, renderHandleMsg, renderPlan } from "./handles.ts";
import { searchMentions, scanRow } from "./scan.ts";
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
  const tab = (STATUSES as string[]).includes(o.tab) ? (o.tab as Status) : "pending";
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
    store.createSession(await tokenHash(tok), row.id, expires);
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
    store.createUser(id, "owner@example.com", await hashPassword("correct-horse-battery"));
    user = store.findUser("owner@example.com")!;
  }
  // Pro so the handle and testimonial caps are exercised but not in the way.
  store.setPlan(user.id, "pro");
  try { store.addHandle(user.id, "acmetools"); } catch { /* already there */ }
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

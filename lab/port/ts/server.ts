// Datastar port of the social-proof dashboard. Web-standard fetch handler,
// SQLite for storage, SSE for every update. No framework, no build step.
//
// Auth is out of scope for the lab: every request is the same demo user, and
// the ownership checks in store.ts are written as if it were real.
import { readFile } from "node:fs/promises";
import { Store, STATUSES, Duplicate, type Status } from "./store.ts";
import { validateManualTestimonial } from "./validate.ts";
import { renderStats, renderTabs, renderList, renderMsg, esc } from "./render.ts";

const USER = "demo-user";
const SHARED = process.env.LAB_SHARED ?? "../shared";
const store = new Store(process.env.LAB_DB ?? "social-proof.db");

// ---------- SSE ----------

class SSE {
  private enc = new TextEncoder();
  constructor(private c: ReadableStreamDefaultController) {}
  // One `data: elements ` line per line of HTML — required by the spec. A
  // single missing prefix makes the patch silently do nothing.
  patch(elems: string) {
    let out = "event: datastar-patch-elements\n";
    for (const line of elems.replace(/\n+$/, "").split("\n")) out += `data: elements ${line}\n`;
    this.c.enqueue(this.enc.encode(out + "\n"));
  }
  signals(json: string) {
    this.c.enqueue(this.enc.encode(`event: datastar-patch-signals\ndata: signals ${json}\n\n`));
  }
}

const stream = (fn: (s: SSE) => void) =>
  new Response(new ReadableStream({
    start(c) { const s = new SSE(c); try { fn(s); } finally { c.close(); } },
  }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });

// Redraw the three regions a mutation can affect. Targeted patches, not a
// whole-page replace: Datastar morphs each by id.
function redraw(s: SSE, tab: Status) {
  const c = store.counts(USER);
  s.patch(renderStats(c));
  s.patch(renderTabs(c, tab));
  s.patch(renderList(store.list(USER, tab), tab, store.total(USER)));
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

// ---------- routes ----------

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p === "/datastar.js") return file(`${SHARED}/datastar.js`, "text/javascript; charset=utf-8");
  if (p === "/styles.css") return file(`${SHARED}/styles.css`, "text/css; charset=utf-8");
  if (p === "/favicon.ico") return new Response(null, { status: 204 });

  if (p === "/" && req.method === "GET") {
    const c = store.counts(USER);
    const page = (await readFile(`${SHARED}/dashboard.html`, "utf8"))
      .replaceAll("__BACKEND__", "TypeScript")
      .replace("__STATS__", renderStats(c))
      .replace("__TABS__", renderTabs(c, "pending"))
      .replace("__LIST__", renderList(store.list(USER, "pending"), "pending", store.total(USER)));
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const { tab, input } = await readSignals(req, url);

  // Tab switch.
  if (p === "/testimonials" && req.method === "GET") return stream((s) => redraw(s, tab));

  // Add by hand. Validation failures patch the message region and stop —
  // no redirect, no page reload, no lost form state.
  if (p === "/testimonials" && req.method === "POST") {
    const result = validateManualTestimonial(input);
    if (!result.ok) return stream((s) => s.patch(renderMsg("err", esc(result.error))));
    try {
      store.insert(USER, crypto.randomUUID(), result.row);
    } catch (e) {
      const msg = e instanceof Duplicate ? "You have already added that one." : "Could not save that. Try again.";
      return stream((s) => s.patch(renderMsg("err", msg)));
    }
    return stream((s) => {
      s.patch(renderMsg("ok", "Added. It is waiting in <strong>Pending</strong> for you to approve."));
      s.signals(`{content: '', authorName: '', authorHandle: '', sourceUrl: '', postedAt: '', tab: 'pending'}`);
      redraw(s, "pending");
    });
  }

  const m = p.match(/^\/testimonials\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    if (req.method === "PATCH") {
      const status = url.searchParams.get("status");
      if (status !== "approved" && status !== "dismissed")
        return new Response('status must be "approved" or "dismissed"', { status: 400 });
      if (!store.setStatus(USER, id, status)) return new Response("not found", { status: 404 });
      return stream((s) => redraw(s, tab));
    }
    if (req.method === "DELETE") {
      if (!store.remove(USER, id)) return new Response("not found", { status: 404 });
      return stream((s) => redraw(s, tab));
    }
  }

  return new Response("not found", { status: 404 });
}

// Sample rows so the dashboard has something to show. Mirrors the mock X data
// the SvelteKit app ships in src/lib/server/sources/x.ts.
function seed() {
  if (store.total(USER) > 0) return;
  const d = (s: string) => new Date(s);
  const rows: [string, string, string, string, string, string, Date, Status][] = [
    ["x", "https://x.com/janes/status/1", "janesmith", "Jane Smith", "Sold our house in nine days and answered the phone every time.", "scan", d("2026-07-14"), "pending"],
    ["x", "https://x.com/dmr/status/2", "dmreid", "Danielle Reid", "Booked them twice now. Turned up when they said they would, which is the whole job.", "scan", d("2026-07-02"), "pending"],
    ["google", "https://g.page/r/demo/review/3", "", "Marcus Bell", "Quoted honestly, finished early, cleaned up after themselves.", "manual", d("2026-06-21"), "approved"],
    ["trustpilot", "https://trustpilot.com/reviews/4", "", "Priya N.", "Third time using them. No notes.", "manual", d("2026-05-30"), "approved"],
    ["x", "https://x.com/spam/status/5", "linkfarm22", "", "check out my crypto course link in bio", "scan", d("2026-06-01"), "dismissed"],
  ];
  for (const [platform, urlStr, handle, name, content, source, postedAt, status] of rows) {
    store.insert(USER, crypto.randomUUID(), {
      source: source as "manual", platform, postId: urlStr, postUrl: urlStr,
      authorHandle: handle || null, authorName: name || null, content, postedAt,
    }, status);
  }
}
seed();

const port = Number(process.env.PORT ?? 8083);
console.log(`social-proof (Datastar/TypeScript) on http://localhost:${port}`);
export default { port, fetch: handle };

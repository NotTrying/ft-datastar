// Datastar lab — TypeScript backend. Web-standard APIs only: no deps, no framework.
// Runs on Bun (`bun server.ts`) and Node 22+. For Cloudflare Workers, swap the
// readFile() call for a text import — everything else is already Workers-compatible.
import { readFile } from "node:fs/promises";

type Item = { id: number; author: string; text: string; approved: boolean };

let items: Item[] = [
  { id: 1, author: "Ada Lovelace", text: "Shipped in an afternoon. No build step at all.", approved: true },
  { id: 2, author: "Grace Hopper", text: "The SSE patching is the whole trick.", approved: false },
  { id: 3, author: "Alan Turing", text: "One file. I keep waiting for the catch.", approved: false },
];
let nextId = 4;

const SHARED = process.env.LAB_SHARED ?? "../shared/index.html";
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- SSE ----------

class SSE {
  private enc = new TextEncoder();
  constructor(private ctrl: ReadableStreamDefaultController) {}

  // One `data: elements ` line per line of HTML — required by the spec.
  patchElements(elems: string, ...opts: string[]) {
    let out = "event: datastar-patch-elements\n";
    for (const o of opts) out += `data: ${o}\n`;
    for (const line of elems.replace(/\n+$/, "").split("\n")) out += `data: elements ${line}\n`;
    this.ctrl.enqueue(this.enc.encode(out + "\n"));
  }
  patchSignals(json: string) {
    this.ctrl.enqueue(this.enc.encode(`event: datastar-patch-signals\ndata: signals ${json}\n\n`));
  }
  close() { try { this.ctrl.close(); } catch {} }
}

const stream = (fn: (s: SSE) => void | Promise<void>) =>
  new Response(
    new ReadableStream({
      async start(ctrl) {
        const s = new SSE(ctrl);
        try { await fn(s); } finally { s.close(); }
      },
    }),
    { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } },
  );

// ---------- signals in ----------

type Signals = { query?: string; author?: string; text?: string };

async function readSignals(req: Request, url: URL): Promise<Signals> {
  const raw = url.searchParams.get("datastar") ?? (req.body ? await req.text() : "");
  if (!raw) return {};
  try { return JSON.parse(raw) as Signals; } catch { return {}; }
}

// ---------- rendering ----------

function renderList(query = ""): string {
  const q = query.trim().toLowerCase();
  const rows = items.filter((it) => !q || `${it.author} ${it.text}`.toLowerCase().includes(q));
  const body = rows.length
    ? rows.map((it) =>
        `<div class="item${it.approved ? " ok" : ""}"><div class="grow">` +
        `<div class="who">${esc(it.author)}</div><div class="txt">${esc(it.text)}</div></div>` +
        `<button title="Approve" data-on:click="@post('/items/toggle?id=${it.id}')">&check;</button>` +
        `<button title="Delete" data-on:click="@delete('/items?id=${it.id}')">&times;</button></div>`,
      ).join("")
    : `<p class="mut">Nothing matches.</p>`;
  return `<div id="list">${body}</div>`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- routes ----------

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sig = await readSignals(req, url);
  const id = Number(url.searchParams.get("id") ?? 0);

  if (url.pathname === "/" ) {
    const tpl = await readFile(SHARED, "utf8"); // re-read per request: edit HTML, hit refresh
    const page = tpl
      .replaceAll("__BACKEND__", `TypeScript ${process.versions.bun ? "Bun " + process.versions.bun : "Node " + process.versions.node}`)
      .replace("__LIST__", renderList(""));
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });

  if (url.pathname === "/datastar.js") {
    const js = await readFile(SHARED.replace("index.html", "datastar.js"), "utf8");
    return new Response(js, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" },
    });
  }

  if (url.pathname === "/search") {
    return stream((s) => s.patchElements(renderList(sig.query)));
  }

  if (url.pathname === "/items") {
    if (req.method === "POST") {
      const a = (sig.author ?? "").trim(), t = (sig.text ?? "").trim();
      if (a && t) items = [{ id: nextId++, author: a, text: t, approved: false }, ...items];
      return stream((s) => {
        s.patchElements(renderList(sig.query));
        s.patchSignals(`{author: '', text: ''}`); // clear the form
      });
    }
    if (req.method === "DELETE") {
      items = items.filter((it) => it.id !== id);
      return stream((s) => s.patchElements(renderList(sig.query)));
    }
    return new Response("method not allowed", { status: 405 });
  }

  if (url.pathname === "/items/toggle") {
    const it = items.find((x) => x.id === id);
    if (it) it.approved = !it.approved;
    return stream((s) => s.patchElements(renderList(sig.query)));
  }

  // One request, many patches over time.
  if (url.pathname === "/import") {
    return stream(async (s) => {
      s.patchSignals(`{importing: true}`);
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        await sleep(320);
        if (req.signal?.aborted) return; // browser navigated away; stop work
        s.patchElements(
          `<div id="progress" class="mut">Importing batch ${i} of ${steps}&hellip;` +
          `<div class="bar"><i style="width:${(i * 100) / steps}%"></i></div></div>`,
        );
      }
      items = [{ id: nextId++, author: "Imported batch", text: "Arrived over a single streaming response.", approved: true }, ...items];
      s.patchElements(`<div id="progress" class="mut">Done — one HTTP request, 9 DOM patches.</div>`);
      s.patchElements(renderList(""));
      s.patchSignals(`{importing: false}`);
    });
  }

  return new Response("not found", { status: 404 });
}

const port = Number(process.env.PORT ?? 8081);
console.log(`TypeScript backend on http://localhost:${port}`);
export default { port, fetch: handle };

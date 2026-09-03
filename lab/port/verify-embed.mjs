// Walls + the public embed. Run against either backend.
import { chromium } from "playwright";
const base = process.argv[2], shot = process.argv[3];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const ctx = await b.newContext();
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", e => errs.push("pageerror: " + e.message));
const ok = [], T = { timeout: 8000 };

// A fake customer site on its own origin, so the embed is genuinely
// cross-origin. It must also be a *private* address: Chrome's Private Network
// Access checks block a public-origin page from framing localhost, which has
// nothing to do with the wall's own CSP.
let wallId = "";
const CUSTOMER = "http://127.0.0.1:8090";
const customer = Bun.serve({
  port: 8090, hostname: "127.0.0.1",
  fetch: () => new Response(
    `<!doctype html><meta charset=utf-8><title>Customer site</title>
     <body style="font:15px system-ui;padding:24px"><h1>Acme Tools</h1><p>What people say:</p>
     <iframe id="w" src="${base}/embed/${wallId}" style="width:100%;border:0;height:620px" title="Testimonials"></iframe>
     <script>window.__h=0;addEventListener("message",e=>{if(e.data&&e.data.type==="sp:height")window.__h=e.data.height})</script>`,
    { headers: { "content-type": "text/html" } }),
});

await p.goto(base, { waitUntil: "networkidle" });
await p.click('button[type=submit]');
await p.waitForURL(u => new URL(u).pathname === "/", T);

// approve everything so the wall has content, including a hostile row
await p.click(".disclosure");
await p.fill("textarea", `<img src=x onerror=alert(1)><script>alert(2)</script> genuinely great`);
await p.fill('input[data-bind\\:author-name]', `</blockquote><b>XSS`);
await p.fill('input[data-bind\\:source-url]', "https://g.page/r/xss/review/1");
await p.click('button[type=submit]');
await p.waitForSelector("#form-msg .alert", T); // ok, or "already added" on a re-run
for (let i = 0; i < 12; i++) {
  const btn = await p.$("#list .t:first-child button.ok");
  if (!btn) break;
  await btn.click();
  await p.waitForTimeout(180);
}

// create a wall
await p.click("text=Walls");
await p.waitForURL(u => new URL(u).pathname === "/walls", T);
await p.fill('input[data-bind\\:wall-name]', "Homepage testimonials");
await p.click('button[type=submit]');
await p.waitForSelector("#walls .wall", T);
wallId = (await p.textContent("#walls .wall .mono")).trim();
ok.push([`wall id is unguessable (${wallId})`, /^wl_[a-z0-9]{20}$/.test(wallId)]);
ok.push(["embed snippet is offered", (await p.inputValue("#walls .wall textarea")).includes(`/embed/${wallId}`)]);

// ---- the embed, headers first ----
const res = await p.request.get(`${base}/embed/${wallId}`);
const csp = res.headers()["content-security-policy"] ?? "";
ok.push(["CSP is default-src 'none' with a per-request nonce",
  csp.includes("default-src 'none'") && /script-src 'nonce-[0-9a-f]{32}'/.test(csp)]);
ok.push(["embed revalidates and is sniff-proof",
  res.headers()["cache-control"] === "no-cache" &&
  res.headers()["x-content-type-options"] === "nosniff"]);
const html = await res.text();
ok.push(["embed ships no Datastar at all",
  !/datastar|data-on:|data-bind:|data-signals/.test(html)]);
const nonce = csp.match(/script-src 'nonce-([0-9a-f]{32})'/)[1];
ok.push(["only the two nonce'd inline tags exist",
  (html.match(/<script/g) || []).length === 1 && (html.match(/<style/g) || []).length === 1 &&
  html.includes(`<script nonce="${nonce}">`) && html.includes(`<style nonce="${nonce}">`)]);
ok.push(["hostile testimonial is escaped, not executed",
  !/<script>alert|<img src=x|<\/blockquote><b>/.test(html) &&
  html.includes("&lt;script&gt;alert(2)&lt;/script&gt;")]);

// ---- rendered cross-origin on a customer site ----
await p.goto(CUSTOMER, { waitUntil: "networkidle" });
await p.waitForTimeout(600);
const frame = p.frames().find(f => f.url().includes("/embed/"));
const renderedCards = frame ? (await frame.$$(".sp-card")).length : 0;
ok.push([`embed renders inside a cross-origin iframe (${renderedCards} cards)`, renderedCards > 0]);
const bodies = frame ? await frame.$$eval(".sp-body", n => n.map(x => x.textContent)) : [];
ok.push(["the payload is inert text in the DOM, not an element",
  !!frame && (await frame.$$("script")).length === 1 && (await frame.$$("img")).length === 0 &&
  bodies.some(t => t.includes("<script>alert(2)</script>"))]);
await p.waitForFunction(() => window.__h > 0, null, T).catch(() => {});
ok.push(["iframe reports its height to the parent via postMessage",
  await p.evaluate(() => window.__h) > 0]);
await p.screenshot({ path: shot, fullPage: true });

// ---- restrict domains: the browser must now refuse the frame ----
await p.goto(`${base}/walls`, { waitUntil: "networkidle" });
await p.fill("#walls .wall input[type=text]", "https://shop.example.com/pricing, *.acme.co.uk");
await p.dispatchEvent("#walls .wall input[type=text]", "change");
await p.waitForTimeout(900);
const res2 = await p.request.get(`${base}/embed/${wallId}`);
ok.push(["domains parsed from pasted URLs into bare hosts",
  (res2.headers()["content-security-policy"] ?? "")
    .includes("frame-ancestors https://shop.example.com https://*.acme.co.uk")]);

await p.goto(CUSTOMER, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(900);
const blocked = p.frames().find(f => f.url().includes("/embed/"));
const blockedCards = blocked ? (await blocked.$$(".sp-card")).length : 0;
ok.push([`a disallowed site can no longer frame the wall (${blockedCards} cards visible)`,
  blockedCards === 0 && renderedCards > 0]);
ok.push(["a tightened allow-list takes effect at once, not after a cache TTL",
  (res2.headers()["cache-control"] ?? "") === "no-cache" && blockedCards === 0]);

// ---- the JSON API ----
const api = async (origin) => (await p.request.get(`${base}/api/v1/walls/${wallId}`,
  { headers: origin ? { Origin: origin } : {}, failOnStatusCode: false })).status();
ok.push(["API allows an allow-listed origin", await api("https://shop.example.com") === 200]);
ok.push(["API allows a wildcard subdomain and its apex",
  await api("https://deep.acme.co.uk") === 200 && await api("https://acme.co.uk") === 200]);
ok.push(["API refuses an origin not on the list", await api("https://evil.com") === 403]);

// ---- pausing hides it entirely ----
await p.goto(`${base}/walls`, { waitUntil: "networkidle" });
await p.click("#walls .wall button.btn.sm");
await p.waitForFunction(() => document.querySelector("#walls .wall .plat")?.textContent === "Paused", null, T);
ok.push(["a paused wall 404s on both public routes",
  (await p.request.get(`${base}/embed/${wallId}`, { failOnStatusCode: false })).status() === 404 &&
  (await p.request.get(`${base}/api/v1/walls/${wallId}`, { failOnStatusCode: false })).status() === 404]);

await b.close();
customer.stop(true);
let bad = 0;
for (const [n, pass] of ok) { console.log((pass ? "  PASS  " : "  FAIL  ") + n); if (!pass) bad++; }
if (errs.length) { console.log("\nJS errors:"); errs.forEach(e => console.log("   " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} problem(s)` : "\nAll green.");
process.exit(bad ? 1 : 0);

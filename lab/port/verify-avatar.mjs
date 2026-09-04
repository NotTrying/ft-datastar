// The avatar proxy: why it exists (privacy) and what it refuses (SSRF, spoofed
// types, oversized bodies).
import { chromium } from "playwright";
const base = process.argv[2], shot = process.argv[3];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const p = await (await b.newContext()).newPage();
const ok = [], T = { timeout: 6000 };
const setAvatar = async (u) =>
  (await (await p.request.get(`${base}/dev/set-avatar${u === null ? "" : `?url=${encodeURIComponent(u)}`}`)).json());
const get = (path) => p.request.get(`${base}${path}`, { failOnStatusCode: false });

let crash = null;
try {
  // --- the rejections ---
  ok.push(["an unknown testimonial id is a 404, not a fetch",
    (await get("/api/v1/avatar/does-not-exist")).status() === 404]);

  const { id } = await setAvatar("https://avatars.test/ok.png");
  ok.push(["a proxied avatar is served", (await get(`/api/v1/avatar/${id}`)).status() === 200]);

  const good = await get(`/api/v1/avatar/${id}`);
  ok.push(["the response is pinned to the type we matched, not the upstream's header",
    good.headers()["content-type"] === "image/png"]);
  ok.push(["it is cacheable, sandboxed and sniff-proof",
    good.headers()["cache-control"].includes("immutable") &&
    good.headers()["content-security-policy"] === "default-src 'none'; sandbox" &&
    good.headers()["x-content-type-options"] === "nosniff"]);
  ok.push(["and CORS-open, since it renders on the customer's site",
    good.headers()["access-control-allow-origin"] === "*"]);

  await setAvatar("http://avatars.test/ok.png");
  ok.push(["a plaintext http avatar is refused even though it came from our own DB",
    (await get(`/api/v1/avatar/${id}`)).status() === 404]);

  await setAvatar("https://avatars.test/lying-type");
  const spoof = await get(`/api/v1/avatar/${id}`);
  ok.push(["an upstream claiming text/html is refused, not re-served",
    spoof.status() === 415 && !(await spoof.text()).includes("<script>")]);

  await setAvatar("https://avatars.test/too-big");
  ok.push(["an oversized avatar is refused", (await get(`/api/v1/avatar/${id}`)).status() === 413]);

  await setAvatar("https://avatars.test/boom");
  ok.push(["an upstream that throws is a 502, not a crash",
    (await get(`/api/v1/avatar/${id}`)).status() === 502]);

  await setAvatar("https://avatars.test/missing");
  ok.push(["an upstream 404 stays a 404", (await get(`/api/v1/avatar/${id}`)).status() === 404]);

  // --- the point of the whole thing ---
  await setAvatar("https://avatars.test/ok.png");
  await p.goto(base, { waitUntil: "networkidle" });
  await p.fill('input[name=email]', "owner@example.com");
  await p.fill('input[name=password]', "correct-horse-battery");
  await p.click('button[type=submit]');
  await p.waitForURL(u => new URL(u).pathname === "/", T);
  // Always create a fresh wall rather than reusing whatever exists: an earlier
  // suite leaves one PAUSED, and a paused wall 404s on both public routes.
  await p.goto(`${base}/walls`, { waitUntil: "networkidle" });
  await p.fill('input[data-bind\\:wall-name]', "Avatar wall");
  await p.click("text=Create wall");
  await p.waitForFunction(() => document.querySelector("#wall-msg .alert.ok"), null, T);
  const wallId = (await p.$$eval("#walls .wall .mono", ns => ns.map(n => n.textContent.trim()))).pop();

  const embed = await (await get(`/embed/${wallId}`)).text();
  const srcs = [...embed.matchAll(/<img[^>]*src="([^"]+)"/g)].map(m => m[1]);
  ok.push([`the wall renders the avatar through our own proxy (${srcs[0] ?? "none"})`,
    srcs.length > 0 && srcs.every(s => s.startsWith("/api/v1/avatar/"))]);
  ok.push(["and no image on the wall points at a third-party host",
    !/<img[^>]*src="https?:\/\//.test(embed)]);

  await p.goto(`${base}/embed/${wallId}`, { waitUntil: "networkidle" });
  ok.push(["the proxied image actually loads inside the wall under its strict CSP",
    await p.$$eval("img.sp-avatar", ns => ns.length > 0 && ns.every(n => n.naturalWidth > 0))]);

  await p.screenshot({ path: shot, fullPage: true });
} catch (e) { crash = e; }

await b.close();
let bad = 0;
for (const [n, pass] of ok) { console.log((pass ? "  PASS  " : "  FAIL  ") + n); if (!pass) bad++; }
if (crash) { console.log(`  CRASH   after ${ok.length} assertions: ${String(crash).split("\n")[0]}`); bad++; }
console.log(bad ? `\n${bad} problem(s)` : "\nAll green.");
process.exit(bad ? 1 : 0);

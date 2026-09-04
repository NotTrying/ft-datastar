// Liveness + health. The rule under test: a quote is retired only on an
// unambiguous negative signal, and an inconclusive check writes nothing at all.
import { chromium } from "playwright";
const base = process.argv[2], shot = process.argv[3];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const p = await (await b.newContext()).newPage();
const ok = [], T = { timeout: 6000 };
const live = async (qs) => (await (await p.request.get(`${base}/dev/liveness?${qs}`)).json());

let crash = null;
try {
  // --- health ---
  const h = await p.request.get(`${base}/api/health`);
  const hj = await h.json();
  ok.push(["health reports healthy with its individual checks",
    h.status() === 200 && hj.status === "healthy" && hj.checks.database && hj.checks.sessions]);
  ok.push(["health is never cached", h.headers()["cache-control"] === "no-store"]);

  // --- a platform we have no reliable check for is never retired ---
  // The platform is set explicitly: this suite runs against a shared database
  // and may have left the row as 'x' on a previous pass.
  let r = await live("platform=google&url=https://x.com/a/status/deleted/x&reset=1&sweep=1");
  ok.push(["a platform with no liveness check is inconclusive, never retired",
    r.result.unknown === 1 && r.state.verify_state !== "gone"]);

  // --- a live post ---
  r = await live("platform=x&url=https://x.com/a/status/alive&reset=1&sweep=1");
  ok.push(["a resolving post is marked live and timestamped",
    r.result.live === 1 && r.state.verify_state === "live" && r.state.last_verified_at > 0]);

  // --- inconclusive signals must write NOTHING ---
  const before = r.state.last_verified_at;
  r = await live("platform=x&url=https://x.com/a/status/ratelimited/x&sweep=1");
  ok.push(["a 429 is inconclusive: state and timestamp both untouched",
    r.result.unknown === 1 && r.state.verify_state === "live" && r.state.last_verified_at === before]);

  r = await live("platform=x&url=https://x.com/a/status/broken/x&sweep=1");
  ok.push(["a network failure is inconclusive too, and writes nothing",
    r.result.unknown === 1 && r.state.verify_state === "live" && r.state.last_verified_at === before]);

  // --- an unambiguous negative ---
  r = await live("platform=x&url=https://x.com/a/status/deleted/x&sweep=1");
  ok.push(["a deleted post (404) is retired",
    r.result.gone === 1 && r.state.verify_state === "gone"]);
  const retiredId = r.id;

  // --- retired stays retired ---
  // The sweep moves on to other rows, which is correct — what matters is that
  // the retired one is not among them and does not flap back to live.
  r = await live("platform=x&url=https://x.com/a/status/alive&sweep=1");
  ok.push(["a retired quote is never re-selected, even once its URL resolves again",
    r.state.verify_state === "gone" && r.result.live === 0]);

  // --- and it leaves the customer's wall ---
  await p.goto(base, { waitUntil: "networkidle" });
  await p.fill('input[name=email]', "owner@example.com");
  await p.fill('input[name=password]', "correct-horse-battery");
  await p.click('button[type=submit]');
  await p.waitForURL(u => new URL(u).pathname === "/", T);
  // Always create a fresh wall rather than reusing whatever exists: an earlier
  // suite leaves one PAUSED, and a paused wall 404s on both public routes.
  await p.goto(`${base}/walls`, { waitUntil: "networkidle" });
  await p.fill('input[data-bind\\:wall-name]', "Liveness wall");
  await p.click("text=Create wall");
  await p.waitForFunction(() => document.querySelector("#wall-msg .alert.ok"), null, T);
  const wallId = (await p.$$eval("#walls .wall .mono", ns => ns.map(n => n.textContent.trim()))).pop();
  const embed = await (await p.request.get(`${base}/embed/${wallId}`)).text();
  ok.push(["the retired quote no longer renders on the wall",
    !embed.includes(retiredId)]);

  const api = await (await p.request.get(`${base}/api/v1/walls/${wallId}`)).json();
  ok.push(["nor is it served by the public wall API",
    !api.items.some((i) => i.id === retiredId)]);
  ok.push(["while the rest of the wall is unaffected", api.items.length > 0]);

  await p.screenshot({ path: shot, fullPage: true });
} catch (e) { crash = e; }

await b.close();
let bad = 0;
for (const [n, pass] of ok) { console.log((pass ? "  PASS  " : "  FAIL  ") + n); if (!pass) bad++; }
if (crash) { console.log(`  CRASH   after ${ok.length} assertions: ${String(crash).split("\n")[0]}`); bad++; }
console.log(bad ? `\n${bad} problem(s)` : "\nAll green.");
process.exit(bad ? 1 : 0);

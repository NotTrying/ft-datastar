// The migration experiment, verified in a browser.
//
// The question this suite answers is not "does better-auth work" — it is
// whether better-auth's session model survives Datastar's transport. Every
// state change here arrives as an SSE patch, so a Set-Cookie that better-auth
// sets on its own Response has to be lifted onto an event stream to take
// effect. In the Go port that composition was impossible (headers flush before
// the handler can set a cookie); these assertions are what "possible" looks
// like when it holds.
import { chromium } from "playwright";
const base = process.argv[2] ?? "http://localhost:8095", shot = process.argv[3];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const ctx = await b.newContext();
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", e => errs.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
const ok = [], T = { timeout: 6000 };
const cookie = async () => (await ctx.cookies()).find(c => c.name.includes("session_token"));

let crash = null;
try {
  // --- the gate ---
  await p.goto(`${base}/`, { waitUntil: "networkidle" });
  ok.push(["an anonymous request to the app is redirected to sign-in",
    new URL(p.url()).pathname === "/login"]);

  await p.fill('input[name=email]', "owner@example.com");
  await p.fill('input[name=password]', "wrong-password");
  await p.click('button[type=submit]');
  await p.waitForSelector("#login-msg .alert.err", T);
  ok.push(["a wrong password is refused, and the refusal arrives as an SSE patch",
    (await p.textContent("#login-msg")).includes("do not match")]);
  ok.push(["a refused sign-in sets no session cookie", !(await cookie())]);

  // --- sign-in over SSE ---
  await p.fill('input[name=password]', "correct-horse-battery");
  await Promise.all([p.waitForEvent("load"), p.click('button[type=submit]')]);
  await p.waitForURL(u => new URL(u).pathname === "/", T);
  ok.push(["signing in lands on the app", new URL(p.url()).pathname === "/"]);

  const c = await cookie();
  ok.push(["better-auth's Set-Cookie survived the SSE response", !!c]);
  ok.push(["the session cookie is HttpOnly, so the browser never exposes the token",
    !!c && c.httpOnly === true]);
  ok.push(["the page is server-rendered with the signed-in identity",
    (await p.textContent(".who")).includes("owner@example.com")]);

  // --- the org plugin, driven entirely from Datastar attributes ---
  ok.push(["no organisations exist yet", (await p.textContent("#orgs")).includes("No organisations")]);

  await p.fill('input[data-bind\\:org-name]', "Acme Tools");
  await Promise.all([p.waitForEvent("load"), p.click('form:has(input[data-bind\\:org-name]) button[type=submit]')]);
  await p.waitForFunction(() => document.querySelector("#orgs").textContent.includes("Acme Tools"), null, T);
  ok.push(["creating an organisation works through the plugin's API", true]);

  await p.fill('input[data-bind\\:org-name]', "Beta Labs");
  await Promise.all([p.waitForEvent("load"), p.click('form:has(input[data-bind\\:org-name]) button[type=submit]')]);
  await p.waitForFunction(() => document.querySelector("#orgs").textContent.includes("Beta Labs"), null, T);

  const before = await cookie();
  const switchBtn = (await p.$$("#orgs button")).at(0);
  await Promise.all([p.waitForEvent("load"), switchBtn.click()]);
  await p.waitForFunction(() => document.querySelector("#orgs").textContent.includes("active"), null, T);
  ok.push(["switching the active organisation takes effect",
    (await p.textContent("#orgs")).includes("active")]);
  // Deliberately asserting that the cookie did NOT change. The port carried
  // session state in the cookie, so switching orgs had to rewrite it; a
  // better-auth session is a database row and the cookie is only a pointer at
  // it. That is a smaller attack surface and one fewer thing the SSE layer has
  // to carry — but it is also why `activeOrganizationId` on the session must
  // never be trusted as proof of membership on its own (see below).
  ok.push(["the session cookie is a pointer, not the state — switching orgs does not rewrite it",
    !!before && (await cookie())?.value === before.value]);

  // --- invitations ---
  await p.fill('input[data-bind\\:invite-email]', "other@example.com");
  await p.click('form:has(input[data-bind\\:invite-email]) button[type=submit]');
  await p.waitForSelector("#org-msg .alert.ok", T);
  ok.push(["an invitation is created", (await p.textContent("#org-msg")).includes("other@example.com")]);
  ok.push(["the server cleared the invite field via a signal patch",
    (await p.inputValue('input[data-bind\\:invite-email]')) === ""]);

  // --- sign-out ---
  await Promise.all([p.waitForEvent("load"), p.click('nav .btn')]);
  await p.waitForURL(u => new URL(u).pathname === "/login", T);
  ok.push(["signing out clears the session cookie through the same path",
    !(await cookie())]);
  await p.goto(`${base}/`, { waitUntil: "networkidle" });
  ok.push(["and the app is closed again afterwards", new URL(p.url()).pathname === "/login"]);

  if (shot) await p.screenshot({ path: shot, fullPage: true });
} catch (e) { crash = e; }

await b.close();
let bad = 0;
for (const [n, pass] of ok) { console.log((pass ? "  PASS  " : "  FAIL  ") + n); if (!pass) bad++; }
if (crash) { console.log(`  CRASH   after ${ok.length} assertions: ${String(crash).split("\n")[0]}`); bad++; }
if (errs.length) { console.log("\nJS errors:"); errs.forEach(e => console.log("   " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} problem(s)` : "\nAll green.");
process.exit(bad ? 1 : 0);

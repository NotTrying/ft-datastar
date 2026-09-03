// Auth-flow checks for the Datastar port. Run against either backend.
import { chromium } from "playwright";
const base = process.argv[2];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const ctx = await b.newContext();
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", e => errs.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
const ok = [], T = { timeout: 6000 };

// 1. gate
await p.goto(base, { waitUntil: "networkidle" });
ok.push(["protected page redirects to /login", new URL(p.url()).pathname === "/login"]);

// 2. wrong password -> inline error, no navigation
await p.fill('input[name=password]', "wrong-password");
await p.click('button[type=submit]');
await p.waitForSelector("#login-msg .alert.err", T);
ok.push(["bad password shows an inline error without leaving the page",
  new URL(p.url()).pathname === "/login"]);
ok.push(["error does not reveal which half was wrong",
  (await p.textContent("#login-msg")).includes("email and password do not match")]);

// 3. correct password -> SSE-driven redirect
await p.fill('input[name=password]', "correct-horse-battery");
await p.click('button[type=submit]');
await p.waitForURL((u) => new URL(u).pathname === "/", T);
ok.push(["correct password redirects via the SSE script patch", true]);
ok.push(["dashboard shows the signed-in account",
  (await p.textContent("nav.top")).includes("owner@example.com")]);

// 4. the session cookie must be invisible to the page
const jsCookies = await p.evaluate(() => document.cookie);
const jar = await ctx.cookies();
ok.push(["session cookie is HttpOnly (unreadable from JS)",
  !jsCookies.includes("sp_session") && jar.some(c => c.name === "sp_session" && c.httpOnly)]);
ok.push(["session cookie is SameSite=Lax", jar.find(c => c.name === "sp_session")?.sameSite === "Lax"]);

// 5. survives a reload
await p.reload({ waitUntil: "networkidle" });
ok.push(["session survives a reload", new URL(p.url()).pathname === "/"]);

// 6. a stale session mid-interaction must redirect, not silently fail
const good = jar.find(c => c.name === "sp_session");
await ctx.clearCookies();
await ctx.addCookies([{ ...good, value: "0".repeat(64) }]);
await p.click("text=Approved (2)");                    // a Datastar SSE request
await p.waitForURL((u) => new URL(u).pathname === "/login", T);
ok.push(["a stale session on an SSE request redirects to /login", true]);

// 7. sign out
await p.fill('input[name=password]', "correct-horse-battery");
await p.click('button[type=submit]');
await p.waitForURL((u) => new URL(u).pathname === "/", T);
await p.click("text=Sign out");
await p.waitForURL((u) => new URL(u).pathname === "/login", T);
ok.push(["sign out returns to /login", true]);
await p.goto(base, { waitUntil: "networkidle" });
ok.push(["session is dead server-side after sign out", new URL(p.url()).pathname === "/login"]);

await b.close();
let bad = 0;
for (const [n, pass] of ok) { console.log((pass ? "  PASS  " : "  FAIL  ") + n); if (!pass) bad++; }
if (errs.length) { console.log("\nJS errors:"); errs.forEach(e => console.log("   " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} problem(s)` : "\nAll green.");
process.exit(bad ? 1 : 0);

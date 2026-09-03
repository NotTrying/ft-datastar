// Profile settings: validation, the three-step email change, and sessions.
import { chromium } from "playwright";
const base = process.argv[2], shot = process.argv[3];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const ctx = await b.newContext();
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", e => errs.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
const ok = [], T = { timeout: 6000 };
const msg = () => p.textContent("#settings-msg").catch(() => "");
const otp = async () => (await (await p.request.get(`${base}/dev/last-otp`)).json()).code;

// The suite changes the account's email part-way through, so later sign-ins
// must say which address they are using rather than trusting the pre-filled one.
const signIn = async (pg, email = "owner@example.com", pw = "correct-horse-battery") => {
  await pg.goto(base, { waitUntil: "networkidle" });
  await pg.fill('input[name=email]', email);
  await pg.fill('input[name=password]', pw);
  await pg.click('button[type=submit]');
  await pg.waitForURL(u => new URL(u).pathname === "/", T);
};
const CHANGED_EMAIL = "new-owner@example.com";

let crash = null;
try {
  await signIn(p);
  await p.click("text=Settings");
  await p.waitForURL(u => new URL(u).pathname === "/settings", T);
  ok.push(["settings page shows the current profile",
    (await p.inputValue('input[data-bind\\:name]')) === "Sam Owner" &&
    (await p.inputValue('input[data-bind\\:email]')) === "owner@example.com"]);

  // --- validation, message-for-message with the original ---
  await p.fill('input[data-bind\\:name]', "");
  await p.click('button[type=submit]');
  await p.waitForFunction(() => document.querySelector("#settings-msg .alert.err"), null, T);
  ok.push(["empty name rejected", (await msg()).includes("Name is required")]);

  // maxlength truncates anything typed, so the client guard and the server rule
  // are asserted separately — the server is the one that actually matters.
  ok.push(["name input carries the maxlength guard",
    (await p.getAttribute('input[data-bind\\:name]', "maxlength")) === "128"]);
  {
    const r = await p.request.post(`${base}/settings/profile`, {
      headers: { "datastar-request": "true", "content-type": "application/json" },
      data: { name: "x".repeat(200), email: "owner@example.com" },
    });
    ok.push(["server rejects an over-long name regardless of the client guard",
      (await r.text()).includes("128 characters or less")]);
  }

  // type="email" means the browser blocks submission before Datastar sees it,
  // so — as with maxlength — the client guard and the server rule are separate
  // assertions. The original has the same behaviour.
  await p.fill('input[data-bind\\:name]', "Sam Owner");
  await p.fill('input[data-bind\\:email]', "not-an-email");
  ok.push(["browser blocks an invalid email before it is sent",
    !(await p.$eval('input[data-bind\\:email]', (n) => n.checkValidity()))]);
  {
    const r = await p.request.post(`${base}/settings/profile`, {
      headers: { "datastar-request": "true", "content-type": "application/json" },
      data: { name: "Sam Owner", email: "not-an-email" },
    });
    ok.push(["server rejects an invalid email regardless of the client guard",
      (await r.text()).includes("Valid email is required")]);
  }

  await p.fill('input[data-bind\\:email]', "other@example.com");
  await p.click('button[type=submit]');
  await p.waitForFunction(() => document.querySelector("#settings-msg .alert.err")?.textContent.includes("already taken"), null, T);
  ok.push(["email already taken rejected", true]);
  await p.fill('input[data-bind\\:email]', "owner@example.com");

  // --- name-only change persists ---
  await p.fill('input[data-bind\\:email]', "owner@example.com");
  await p.fill('input[data-bind\\:name]', "Renamed Owner");
  await p.click('button[type=submit]');
  await p.waitForSelector("#settings-msg .alert.ok", T);
  ok.push(["name-only change saves", (await msg()).includes("Profile updated successfully")]);
  await p.reload({ waitUntil: "networkidle" });
  ok.push(["renamed value survives a reload",
    (await p.inputValue('input[data-bind\\:name]')) === "Renamed Owner"]);

  // --- the three-step email change ---
  await p.fill('input[data-bind\\:email]', "new-owner@example.com");
  await p.click('button[type=submit]');
  await p.waitForSelector('input[data-bind\\:otp]', T);
  ok.push(["email change moves to step 1 without the page holding any step state",
    (await p.textContent("#profile-panel")).includes("owner@example.com")]);

  await p.fill('input[data-bind\\:otp]', "000000");
  await p.click('#profile-panel button[type=submit]');
  await p.waitForFunction(() => document.querySelector("#settings-msg .alert.err"), null, T);
  ok.push(["wrong code at step 1 rejected", (await msg()).includes("Invalid or expired")]);

  await p.fill('input[data-bind\\:otp]', await otp());
  await p.click('#profile-panel button[type=submit]');
  await p.waitForFunction(() => document.querySelector("#settings-msg .alert.ok")?.textContent.includes("Current email verified"), null, T);
  ok.push(["correct code advances to step 2, addressed to the NEW address",
    (await p.textContent("#profile-panel")).includes("new-owner@example.com")]);

  await p.fill('input[data-bind\\:otp]', await otp());
  await p.click('#profile-panel button[type=submit]');
  await p.waitForFunction(() => document.querySelector("#settings-msg .alert.ok")?.textContent.includes("updated successfully"), null, T);
  ok.push(["step 2 commits the new email", true]);
  await p.reload({ waitUntil: "networkidle" });
  ok.push(["new email persisted and shown in the nav",
    (await p.inputValue('input[data-bind\\:email]')) === "new-owner@example.com" &&
    (await p.textContent("nav.top")).includes("new-owner@example.com")]);

  // --- cancel returns to the form ---
  await p.fill('input[data-bind\\:email]', "cancelled@example.com");
  await p.click('button[type=submit]');
  await p.waitForSelector('input[data-bind\\:otp]', T);
  await p.click("text=Cancel");
  await p.waitForSelector('input[data-bind\\:name]', T);
  ok.push(["cancel returns to the profile form", (await p.$$('input[data-bind\\:otp]')).length === 0]);

  // --- sessions ---
  // Counts are relative, so the suite does not care how many sessions a
  // previous run left behind.
  const count = async () => (await p.$$("#sessions .session")).length;
  const currentRow = () => p.$('#sessions .session:has(.plat)');

  ok.push(["the current session is marked as this device", !!(await currentRow())]);
  ok.push(["the current session offers no revoke button",
    (await (await currentRow()).$$("button.danger")).length === 0]);

  const before = await count();
  const p2 = await (await b.newContext()).newPage();       // a second device
  await signIn(p2, CHANGED_EMAIL);
  await p.reload({ waitUntil: "networkidle" });
  ok.push([`a second sign-in appears in the list (${before} -> ${await count()})`,
    (await count()) === before + 1]);

  // Newest first, so the first revocable row is the device that just signed in.
  await p.click("#sessions .session button.danger");
  await p.waitForFunction((n) => document.querySelectorAll("#sessions .session").length === n,
    before, T);
  ok.push(["revoking another session removes it", (await msg()).includes("Session revoked")]);
  await p2.reload({ waitUntil: "networkidle" });
  ok.push(["the revoked device is signed out", new URL(p2.url()).pathname === "/login"]);

  const p3 = await (await b.newContext()).newPage();
  await signIn(p3, CHANGED_EMAIL);
  await p.reload({ waitUntil: "networkidle" });
  await p.click("text=/Sign out \\d+ other/");
  await p.waitForFunction(() => document.querySelectorAll("#sessions .session").length === 1, null, T);
  ok.push(["sign out everywhere leaves only the current session",
    (await msg()).includes("All other sessions revoked")]);
  await p3.reload({ waitUntil: "networkidle" });
  ok.push(["that device is signed out too", new URL(p3.url()).pathname === "/login"]);

  await p.screenshot({ path: shot, fullPage: true });
} catch (e) { crash = e; }
await b.close();
let bad = 0;
for (const [n, pass] of ok) { console.log((pass ? "  PASS  " : "  FAIL  ") + n); if (!pass) bad++; }
if (crash) { console.log(`  CRASH   after ${ok.length} assertions: ${String(crash).split("\n")[0]}`); bad++; }
if (errs.length) { console.log("\nJS errors:"); errs.forEach(e => console.log("   " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} problem(s)` : "\nAll green.");
process.exit(bad ? 1 : 0);

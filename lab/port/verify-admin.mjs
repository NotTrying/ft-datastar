// Admin: the role gate, banning (and what a ban actually does), and deletion.
import { chromium } from "playwright";
const base = process.argv[2], shot = process.argv[3];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const p = await (await b.newContext()).newPage();
const errs = [];
p.on("pageerror", e => errs.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
const ok = [], T = { timeout: 6000 };
const msg = () => p.textContent("#admin-msg").catch(() => "");

const signIn = async (pg, email, pw = "correct-horse-battery") => {
  await pg.goto(base, { waitUntil: "networkidle" });
  await pg.fill('input[name=email]', email);
  await pg.fill('input[name=password]', pw);
  await pg.click('button[type=submit]');
};

let crash = null;
const VICTIM = "disposable@example.com";
try {
  // A throwaway account, because this suite bans and then DELETES it. Consuming
  // a seeded account would break the org and settings suites, which run against
  // the same database.
  const boot = await (await b.newContext()).newPage();
  await boot.goto(`${base}/dev/make-user?email=${encodeURIComponent(VICTIM)}`);
  await boot.close();

  // --- the gate ---
  const plain = await (await b.newContext()).newPage();
  await signIn(plain, VICTIM);
  await plain.waitForURL(u => new URL(u).pathname === "/", T);
  ok.push(["a non-admin is shown no Admin link",
    !(await plain.textContent("nav.top")).includes("Admin")]);
  const denied = await plain.request.get(`${base}/admin`, { failOnStatusCode: false });
  ok.push(["a non-admin is refused the admin page", denied.status() === 403]);
  const deniedAction = await plain.request.delete(`${base}/admin/users/x`,
    { headers: { "datastar-request": "true" }, failOnStatusCode: false });
  ok.push(["and refused the admin mutations too, not just the page", deniedAction.status() === 403]);

  // --- the admin ---
  await signIn(p, "owner@example.com");
  await p.waitForURL(u => new URL(u).pathname === "/", T);
  ok.push(["an admin is shown the Admin link", (await p.textContent("nav.top")).includes("Admin")]);
  await p.click("nav.top >> text=Admin");
  await p.waitForURL(u => new URL(u).pathname === "/admin", T);
  const listed = (await p.$$("#users .adminuser")).length;
  ok.push([`the user list renders (${listed} users)`, listed >= 2]);
  ok.push(["the admin's own row is marked and offers no actions",
    (await p.textContent("#users .adminuser:has(.plat:text-is('admin'))")).includes("you") &&
    (await (await p.$('#users .adminuser:has(.plat:text-is("admin"))')).$$("button")).length === 0]);

  // --- banning ---
  const targetRow = `#users .adminuser:has-text("${VICTIM}")`;
  await p.click(`${targetRow} >> text=Ban`);
  await p.waitForSelector('input[data-bind\\:ban-reason]', { state: "visible", timeout: 3000 });
  ok.push(["the ban form opens only for the row being banned",
    (await p.$$eval(".banform", ns => ns.filter(n => n.offsetParent !== null).length)) === 1]);

  const emptyReason = await p.request.post(`${base}/admin/users/nonexistent/ban`,
    { headers: { "datastar-request": "true", "content-type": "application/json" }, data: {}, failOnStatusCode: false });
  ok.push(["banning an unknown user is a 404", emptyReason.status() === 404]);

  await p.fill('input[data-bind\\:ban-reason]', "Spamming testimonials");
  await p.click("text=Confirm ban");
  await p.waitForSelector("#admin-msg .alert.ok", T);
  ok.push(["banning succeeds", (await msg()).includes("banned successfully")]);
  ok.push(["the banned user is marked with their reason",
    (await p.textContent(targetRow)).includes("banned") &&
    (await p.textContent(targetRow)).includes("Spamming testimonials")]);

  // a ban must end the session, not wait for the cookie to expire
  await plain.goto(`${base}/`, { waitUntil: "networkidle" });
  ok.push(["the ban ends the banned user's existing session immediately",
    new URL(plain.url()).pathname === "/login"]);
  await signIn(plain, VICTIM);
  await plain.waitForSelector("#login-msg .alert.err", T);
  ok.push(["and they cannot sign back in",
    (await plain.textContent("#login-msg")).includes("suspended")]);

  // --- self-protection ---
  const selfBan = await p.request.post(`${base}/admin/users/${(await p.getAttribute('#users .adminuser:has(.plat:text-is("admin"))', "id")).replace("user-", "")}/ban`,
    { headers: { "datastar-request": "true", "content-type": "application/json" },
      data: { banReason: "oops" }, failOnStatusCode: false });
  ok.push(["an admin cannot ban themselves", (await selfBan.text()).includes("cannot ban yourself")]);

  // --- unban ---
  await p.click(`${targetRow} >> text=Unban`);
  await p.waitForFunction(() => document.querySelector("#admin-msg .alert.ok")?.textContent.includes("unbanned"), null, T);
  ok.push(["unbanning restores the account", !(await p.textContent(targetRow)).includes("banned")]);
  await signIn(plain, VICTIM);
  await plain.waitForURL(u => new URL(u).pathname === "/", T);
  ok.push(["an unbanned user can sign in again", true]);

  // --- deletion ---
  const before = (await p.$$("#users .adminuser")).length;
  await p.click(`${targetRow} >> text=Delete`);
  await p.waitForFunction((n) => document.querySelectorAll("#users .adminuser").length === n - 1, before, T);
  ok.push(["deleting a user removes them", (await msg()).includes("User deleted")]);
  await plain.goto(`${base}/`, { waitUntil: "networkidle" });
  ok.push(["the deleted user's session is gone too", new URL(plain.url()).pathname === "/login"]);

  await p.screenshot({ path: shot, fullPage: true });
} catch (e) { crash = e; }

await b.close();
let bad = 0;
for (const [n, pass] of ok) { console.log((pass ? "  PASS  " : "  FAIL  ") + n); if (!pass) bad++; }
if (crash) { console.log(`  CRASH   after ${ok.length} assertions: ${String(crash).split("\n")[0]}`); bad++; }
if (errs.length) { console.log("\nJS errors:"); errs.forEach(e => console.log("   " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} problem(s)` : "\nAll green.");
process.exit(bad ? 1 : 0);

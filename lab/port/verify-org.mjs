// Organisations: personal-org bootstrap, members, invitations, roles.
import { chromium } from "playwright";
const base = process.argv[2], shot = process.argv[3];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const p = await (await b.newContext()).newPage();
const errs = [];
p.on("pageerror", e => errs.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
const ok = [], T = { timeout: 6000 };
const msg = (pg = p) => pg.textContent("#org-msg").catch(() => "");

const signIn = async (pg, email, pw = "correct-horse-battery") => {
  await pg.goto(base, { waitUntil: "networkidle" });
  await pg.fill('input[name=email]', email);
  await pg.fill('input[name=password]', pw);
  await pg.click('button[type=submit]');
  await pg.waitForURL(u => new URL(u).pathname === "/", T);
};

let crash = null;
try {
  await signIn(p, "owner@example.com");
  await p.goto(`${base}/org`, { waitUntil: "networkidle" });
  ok.push(["a personal workspace exists on first sign-in",
    (await p.textContent("h1")).includes("workspace")]);
  ok.push(["the owner is listed as owner, marked as you, and not removable",
    (await p.textContent("#members")).includes("owner") &&
    (await p.textContent("#members")).includes("you") &&
    (await p.$$("#members button.danger")).length === 0]);

  // --- invite validation ---
  await p.fill('input[data-bind\\:invite-email]', "owner@example.com");
  await p.click('button[type=submit]');
  await p.waitForFunction(() => document.querySelector("#org-msg .alert.err"), null, T);
  ok.push(["inviting an existing member is refused", (await msg()).includes("already a member")]);

  await p.fill('input[data-bind\\:invite-email]', "other@example.com");
  await p.click('button[type=submit]');
  await p.waitForSelector("#org-msg .alert.ok", T);
  ok.push(["invitation created", (await p.textContent("#invites")).includes("other@example.com")]);
  ok.push(["the invite form is cleared by the server",
    (await p.inputValue('input[data-bind\\:invite-email]')) === ""]);

  await p.fill('input[data-bind\\:invite-email]', "other@example.com");
  await p.click('button[type=submit]');
  await p.waitForFunction(() => document.querySelector("#org-msg .alert.err"), null, T);
  ok.push(["a duplicate invitation is refused", (await msg()).includes("pending invitation")]);

  const link = (await p.textContent("#invites .mono")).trim();
  ok.push([`the invite link is shown (${link.split("/").pop().slice(0, 12)}…)`, link.includes("/invite/inv_")]);

  // --- the invitee ---
  const p2 = await (await b.newContext()).newPage();
  await signIn(p2, "other@example.com");
  await p2.goto(`${base}/org`, { waitUntil: "networkidle" });
  const ownName = await p2.textContent("h1");
  ok.push(["the invitee starts in their own personal workspace", ownName.includes("workspace")]);

  await p2.goto(link, { waitUntil: "networkidle" });
  ok.push(["the invitation page names the organisation and role",
    (await p2.textContent("#invite-body")).includes("as") &&
    (await p2.textContent("#invite-body")).includes("member")]);

  // someone else's invitation must not be usable
  const r = await p.request.post(`${link}/accept`, { headers: { "datastar-request": "true" }, failOnStatusCode: false });
  ok.push(["an invitation addressed to someone else is refused", r.status() === 403]);

  await p2.click("text=Accept");
  await p2.waitForURL(u => new URL(u).pathname === "/org", T);
  await p2.waitForLoadState("networkidle");
  ok.push(["accepting switches the invitee into that organisation",
    !(await p2.textContent("h1")).includes(ownName.trim())]);
  ok.push(["the invitee can now switch between two organisations",
    (await p2.$$("#org-switcher .btn")).length === 2]);
  ok.push(["a plain member is told they cannot invite",
    (await p2.textContent("body")).includes("Only an owner or admin can invite")]);

  // Data is scoped to the organisation, so an accepted member sees its rows —
  // not the empty personal workspace they arrived from. Everything here is
  // compared against what the OWNER currently sees rather than fixed numbers:
  // check.sh runs every suite against one database, and the earlier suites
  // have already added, approved, scanned and deleted rows by this point.
  await p.goto(`${base}/`, { waitUntil: "networkidle" });
  const ownerStats = JSON.stringify(await p.$$eval("#stats .stat b", ns => ns.map(n => +n.textContent)));
  await p.goto(`${base}/handles`, { waitUntil: "networkidle" });
  const ownerHandles = (await p.$$eval("#handles .handle .name", ns => ns.map(n => n.textContent))).sort();

  await p2.goto(`${base}/`, { waitUntil: "networkidle" });
  ok.push([`an accepted member sees the organisation's testimonials, not their own (${ownerStats})`,
    JSON.stringify(await p2.$$eval("#stats .stat b", ns => ns.map(n => +n.textContent))) === ownerStats &&
    ownerStats !== "[0,0,0]"]);
  await p2.goto(`${base}/handles`, { waitUntil: "networkidle" });
  ok.push([`and the same monitored handles (${ownerHandles.length})`,
    JSON.stringify((await p2.$$eval("#handles .handle .name", ns => ns.map(n => n.textContent))).sort())
      === JSON.stringify(ownerHandles)]);

  await p.goto(`${base}/org`, { waitUntil: "networkidle" });
  ok.push(["the owner now sees two members", (await p.$$("#members .member")).length === 2]);
  ok.push(["the accepted invitation is no longer pending",
    (await p.textContent("#invites")).includes("No pending invitations")]);

  // --- removal ---
  const rm = await p2.request.delete(`${base}/org/members/x`, { headers: { "datastar-request": "true" }, failOnStatusCode: false });
  ok.push(["a plain member cannot remove anyone", rm.status() === 403]);

  await p.click("#members button.danger");
  await p.waitForFunction(() => document.querySelectorAll("#members .member").length === 1, null, T);
  ok.push(["the owner can remove a member", (await msg()).includes("Member removed")]);

  await p2.goto(`${base}/org`, { waitUntil: "networkidle" });
  ok.push(["a removed member falls back to their own workspace, not the one they left",
    (await p2.textContent("h1")).includes("workspace") &&
    (await p2.$$("#members .member")).length === 1]);

  // --- creating another org ---
  await p.fill('input[data-bind\\:org-name]', "Acme Tools");
  await p.click("text=Create");
  await p.waitForFunction(() => document.querySelector("h1")?.textContent.includes("Acme Tools"), null, T);
  ok.push(["creating an organisation switches into it and makes you its owner",
    (await p.textContent("#members")).includes("owner")]);
  ok.push(["the switcher now lists both", (await p.$$("#org-switcher .btn")).length === 2]);

  // The whole point of the refactor: rows belong to an organisation, so a new
  // one starts empty even though the same user owns both.
  await p.goto(`${base}/`, { waitUntil: "networkidle" });
  ok.push(["a newly created organisation starts with no testimonials",
    JSON.stringify(await p.$$eval("#stats .stat b", ns => ns.map(n => +n.textContent))) === "[0,0,0]"]);
  await p.goto(`${base}/handles`, { waitUntil: "networkidle" });
  ok.push(["and no monitored handles", (await p.textContent("#handles")).includes("No handles yet")]);
  await p.goto(`${base}/walls`, { waitUntil: "networkidle" });
  ok.push(["and no walls", (await p.textContent("#walls")).includes("No walls yet")]);

  // Switching back brings the original org's data with it.
  await p.goto(`${base}/org`, { waitUntil: "networkidle" });
  const buttons = await p.$$("#org-switcher .btn");
  const target = [];
  for (const btn of buttons) if ((await btn.textContent()).includes("workspace")) target.push(btn);
  // The switcher redirects via a patched <script> back to /org — the page it is
  // already on. waitForURL therefore resolves immediately, before the redirect
  // has even fired, and the next navigation aborts it mid-flight. Wait for the
  // real document load instead.
  await Promise.all([p.waitForEvent("load"), target[0].click()]);
  await p.goto(`${base}/`, { waitUntil: "networkidle" });
  ok.push(["switching back restores the original organisation's data",
    JSON.stringify(await p.$$eval("#stats .stat b", ns => ns.map(n => +n.textContent))) === ownerStats]);

  await p.screenshot({ path: shot, fullPage: true });
} catch (e) { crash = e; }

await b.close();
let bad = 0;
for (const [n, pass] of ok) { console.log((pass ? "  PASS  " : "  FAIL  ") + n); if (!pass) bad++; }
if (crash) { console.log(`  CRASH   after ${ok.length} assertions: ${String(crash).split("\n")[0]}`); bad++; }
if (errs.length) { console.log("\nJS errors:"); errs.forEach(e => console.log("   " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} problem(s)` : "\nAll green.");
process.exit(bad ? 1 : 0);

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
  ok.push(["accepting switches the invitee into that organisation",
    !(await p2.textContent("h1")).includes(ownName.trim())]);
  ok.push(["the invitee can now switch between two organisations",
    (await p2.$$("#org-switcher .btn")).length === 2]);
  ok.push(["a plain member is told they cannot invite",
    (await p2.textContent("body")).includes("Only an owner or admin can invite")]);

  await p.reload({ waitUntil: "networkidle" });
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

  await p.screenshot({ path: shot, fullPage: true });
} catch (e) { crash = e; }

await b.close();
let bad = 0;
for (const [n, pass] of ok) { console.log((pass ? "  PASS  " : "  FAIL  ") + n); if (!pass) bad++; }
if (crash) { console.log(`  CRASH   after ${ok.length} assertions: ${String(crash).split("\n")[0]}`); bad++; }
if (errs.length) { console.log("\nJS errors:"); errs.forEach(e => console.log("   " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} problem(s)` : "\nAll green.");
process.exit(bad ? 1 : 0);

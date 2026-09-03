// Handles + streaming scan. Run against either backend.
import { chromium } from "playwright";
const base = process.argv[2], shot = process.argv[3];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const p = await b.newPage();
const errs = [];
p.on("pageerror", e => errs.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
const ok = [], T = { timeout: 8000 };
const rows = () => p.$$eval("#scan-feed .scan-row", n => n.length).catch(() => 0);

await p.goto(base, { waitUntil: "networkidle" });
await p.click('button[type=submit]');                       // sign in
await p.waitForURL(u => new URL(u).pathname === "/", T);
await p.click("text=Handles");
await p.waitForURL(u => new URL(u).pathname === "/handles", T);
ok.push(["handles page loads with the seeded handle",
  (await p.textContent("#handles")).includes("@acmetools")]);
ok.push(["plan line reflects the pro plan",
  (await p.textContent("#plan-line")).includes("1 of 5")]);

// validation, ported from the original
await p.fill('input[data-bind\\:handle]', "not a handle!");
await p.click('button[type=submit]');
await p.waitForSelector("#handle-msg .alert.err", T);
ok.push(["invalid handle rejected with the original's message",
  (await p.textContent("#handle-msg")).includes("letters, numbers, and underscores")]);

await p.fill('input[data-bind\\:handle]', "@acmetools");
await p.click('button[type=submit]');
await p.waitForFunction(() => document.querySelector("#handle-msg .alert.err")?.textContent.includes("already monitoring"), null, T);
ok.push(["duplicate handle rejected", true]);

await p.fill('input[data-bind\\:handle]', "@bettertools");
await p.click('button[type=submit]');
await p.waitForFunction(() => document.querySelectorAll("#handles .handle").length === 2, null, T);
ok.push(["adding a handle patches the list and the plan line",
  (await p.textContent("#plan-line")).includes("2 of 5")]);
ok.push(["server cleared the handle signal", (await p.inputValue('input[data-bind\\:handle]')) === ""]);

// ---- the streaming scan ----
await p.click("#handles .handle:first-child button.ok");

// buttons must go disabled while scanning — this is the server patching a
// `_`-prefixed (local-only) signal, which is the open question.
await p.waitForTimeout(350);
const disabledMidScan = await p.$$eval("#handles button.ok", ns => ns.every(n => n.disabled));
ok.push(["server can patch a `_`-prefixed local signal (buttons disable mid-scan)", disabledMidScan]);

// progressive arrival: record how many distinct row counts we observe
const seen = new Set();
for (let i = 0; i < 60; i++) {
  seen.add(await rows());
  if (await p.$("#scan-summary .alert")) break;
  await p.waitForTimeout(120);
}
await p.waitForSelector("#scan-summary .alert.ok", T);
ok.push([`rows arrived progressively (${[...seen].sort((a,b)=>a-b).join("→")}), not in one shot`, seen.size >= 4]);
ok.push(["summary reports 5 found / 5 new",
  (await p.textContent("#scan-summary")).includes("5 found") &&
  (await p.textContent("#scan-summary")).includes("5 new")]);
ok.push(["scan buttons re-enabled afterwards",
  await p.$$eval("#handles button.ok", ns => ns.every(n => !n.disabled))]);
ok.push(["handle card now shows the pending count",
  (await p.textContent("#handles .handle:first-child")).includes("5 pending")]);

// rescan: sinceId narrows the search and everything is already stored
await p.click("#handles .handle:first-child button.ok");
await p.waitForFunction(() => document.querySelector("#scan-summary .alert")?.textContent.includes("2 found"), null, { timeout: 12000 });
ok.push(["rescan finds fewer and dedupes them all",
  (await p.textContent("#scan-summary")).includes("0 new")]);

await p.screenshot({ path: shot, fullPage: true });

// scanned rows reached the dashboard
await p.click("text=Dashboard");
await p.waitForURL(u => new URL(u).pathname === "/", T);
ok.push(["scanned mentions land in the dashboard as Pending",
  (await p.textContent("#stats")).includes("7")]);

// remove
await p.click("text=Handles");
await p.waitForURL(u => new URL(u).pathname === "/handles", T);
await p.click("#handles .handle:first-child button.danger");
await p.waitForFunction(() => document.querySelectorAll("#handles .handle").length === 1, null, T);
ok.push(["removing a handle patches the list and the plan line",
  (await p.textContent("#plan-line")).includes("1 of 5")]);

// plan cap
for (const h of ["one", "two", "three", "four"]) {
  await p.fill('input[data-bind\\:handle]', h);
  await p.click('button[type=submit]');
  await p.waitForTimeout(220);
}
await p.fill('input[data-bind\\:handle]', "sixth");
await p.click('button[type=submit]');
await p.waitForSelector("#handle-msg .alert.err", T);
ok.push(["6th handle refused by the pro plan cap of 5",
  (await p.textContent("#handle-msg")).includes("Handle limit reached")]);

await b.close();
let bad = 0;
for (const [n, pass] of ok) { console.log((pass ? "  PASS  " : "  FAIL  ") + n); if (!pass) bad++; }
if (errs.length) { console.log("\nJS errors:"); errs.forEach(e => console.log("   " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} problem(s)` : "\nAll green.");
process.exit(bad ? 1 : 0);

import { chromium } from "playwright";
const base = process.argv[2], shot = process.argv[3];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const p = await b.newPage();
const errs = [];
p.on("pageerror", e => errs.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });

const stats = () => p.$$eval("#stats .stat b", ns => ns.map(n => +n.textContent));
const ok = [];
const T = { timeout: 5000 };

await p.goto(base, { waitUntil: "networkidle" });
ok.push(["seed renders 2 pending / 2 approved / 1 dismissed", JSON.stringify(await stats()) === "[2,2,1]"]);
ok.push(["pending tab shows 2 cards", (await p.$$("#list .t")).length === 2]);

// tab switch is a server round-trip
await p.click("text=Approved (2)");
await p.waitForFunction(() => document.querySelectorAll("#list .t").length === 2 &&
  document.querySelector('.tab[aria-selected="true"]').textContent.startsWith("Approved"), null, T);
ok.push(["tab switch patches list + tabs server-side", true]);
await p.click("text=Dismissed (1)");
await p.waitForFunction(() => document.querySelectorAll("#list .t").length === 1, null, T);
ok.push(["dismissed tab shows 1 card", true]);

// open the add panel (local `_` signal, never sent to the server)
await p.click(".disclosure");
await p.waitForSelector("#add-panel", { state: "visible", timeout: 3000 });

// invalid submit: error patched in, form state kept
await p.fill("textarea", "They were great.");
await p.fill('input[data-bind\\:author-name]', "Test Person");
await p.click('button[type=submit]');
await p.waitForSelector("#form-msg .alert.err", T);
ok.push(["missing URL rejected with the original's message",
  (await p.textContent("#form-msg .alert.err")).includes("link to the original is required")]);
ok.push(["form keeps what was typed after a failed submit",
  (await p.inputValue("textarea")) === "They were great."]);

// valid submit
await p.fill('input[data-bind\\:source-url]', "https://g.page/r/browser/review/1");
await p.click('button[type=submit]');
await p.waitForSelector("#form-msg .alert.ok", T);
await p.waitForFunction(() => document.querySelectorAll("#stats .stat b")[0].textContent === "3", null, T);
ok.push(["valid add increments Pending to 3", true]);
ok.push(["server cleared the form signals", (await p.inputValue("textarea")) === ""]);
ok.push(["add switched the view back to Pending",
  (await p.textContent('.tab[aria-selected="true"]')).startsWith("Pending")]);

// duplicate
await p.fill("textarea", "Same review again.");
await p.fill('input[data-bind\\:author-name]', "Test Person");
await p.fill('input[data-bind\\:source-url]', "https://g.page/r/browser/review/1/");
await p.click('button[type=submit]');
await p.waitForSelector("#form-msg .alert.err", T);
ok.push(["trailing-slash duplicate rejected by URL normalisation",
  (await p.textContent("#form-msg .alert.err")).includes("already added")]);

// approve from the pending tab
await p.click("#list .t:first-child button.ok");
await p.waitForFunction(() => {
  const n = [...document.querySelectorAll("#stats .stat b")].map(x => +x.textContent);
  return n[0] === 2 && n[1] === 3;
}, null, T);
ok.push(["approve moves the row and updates all three counts", true]);

// remove from the approved tab
await p.click("text=Approved (3)");
await p.waitForFunction(() => document.querySelectorAll("#list .t").length === 3, null, T);
await p.click("#list .t:first-child button.danger");
await p.waitForFunction(() => document.querySelectorAll("#list .t").length === 2, null, T);
ok.push(["remove deletes the row and repatches", (await stats())[1] === 2]);

await p.click("text=Pending (2)");
await p.waitForFunction(() => document.querySelectorAll("#list .t").length === 2, null, T);
await p.screenshot({ path: shot, fullPage: true });
await b.close();

let bad = 0;
for (const [n, pass] of ok) { console.log((pass ? "  PASS  " : "  FAIL  ") + n); if (!pass) bad++; }
if (errs.length) { console.log("\nJS errors:"); errs.forEach(e => console.log("   " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} problem(s)` : "\nAll green.");
process.exit(bad ? 1 : 0);

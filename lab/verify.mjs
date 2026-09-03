import { chromium } from "playwright";
const base = process.argv[2] || "http://localhost:8080";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const p = await b.newPage();
const errs = [];
p.on("pageerror", e => errs.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });

await p.goto(base, { waitUntil: "networkidle" });
const ok = [];

// 1. client-only signals
await p.click("text=+"); await p.click("text=+"); await p.click("text=+");
ok.push(["counter increments client-side", (await p.textContent(".count")).trim() === "3"]);

// 2. debounced live search over SSE
await p.fill('input[data-bind\\:query]', "hopper");
await p.waitForFunction(() => document.querySelectorAll("#list .item").length === 1, null, { timeout: 4000 });
ok.push(["search filters via SSE patch", (await p.textContent("#list .who")).includes("Grace")]);
await p.fill('input[data-bind\\:query]', "");
await p.waitForFunction(() => document.querySelectorAll("#list .item").length === 3, null, { timeout: 4000 });

// 3. add -> server patches list AND clears the form
await p.fill('input[data-bind\\:author]', "Browser Test");
await p.fill('input[data-bind\\:text]', "round-tripped through SSE");
await p.click('button[type=submit]');
await p.waitForFunction(() => document.querySelectorAll("#list .item").length === 4, null, { timeout: 4000 });
ok.push(["add renders new row", (await p.textContent("#list .item .who")).includes("Browser Test")]);
ok.push(["server cleared the form signals", (await p.inputValue('input[data-bind\\:author]')) === ""]);

// 4. toggle approve
await p.click('#list .item:first-child button[title=Approve]');
await p.waitForFunction(() => document.querySelector("#list .item").className.includes("ok"), null, { timeout: 4000 });
ok.push(["toggle approve patches in place", true]);

// 5. streaming: many patches from ONE request
let patches = 0;
await p.exposeFunction("__tick", () => patches++);
await p.evaluate(() => new MutationObserver(() => window.__tick())
  .observe(document.getElementById("progress"), { childList: true, subtree: true, characterData: true }));
await p.click("text=Run import");
await p.waitForFunction(() => document.getElementById("progress").textContent.includes("Done"), null, { timeout: 15000 });
ok.push([`streaming pushed ${patches} progressive updates from 1 request`, patches >= 8]);

await p.screenshot({ path: process.argv[3] || "/tmp/lab.png", fullPage: true });
await b.close();

let bad = 0;
for (const [name, pass] of ok) { console.log((pass ? "  PASS  " : "  FAIL  ") + name); if (!pass) bad++; }
if (errs.length) { console.log("\nJS errors:"); errs.forEach(e => console.log("   " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} problem(s)` : "\nAll green.");
process.exit(bad ? 1 : 0);

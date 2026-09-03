#!/usr/bin/env bun
/**
 * Static checks for the Datastar attribute layer.
 *
 * Datastar reports some mistakes loudly and others not at all (see
 * CHECKS.md). The silent ones share a failure mode with the dead-CSS-class
 * problem social-proof already guards against: an unrecognised NAME is simply
 * ignored, so nothing errors — the behaviour just quietly stops happening.
 *
 * This is the equivalent guard. It reads the HTML templates and every HTML
 * fragment emitted from the Go and TypeScript renderers, and fails the build on:
 *
 *   1. unknown `data-*` attributes            (data-txet)
 *   2. unknown modifiers                      (__debownce)
 *   3. an uppercase letter in an attribute KEY (data-bind:authorName)
 *   4. signals read but never declared        ($totallyUndeclared)
 *   5. patch targets that exist in no template
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ATTRS = new Set([ // v1.0.3, free tier
  "attr","bind","class","computed","effect","ignore","ignore-morph","indicator","init",
  "json-signals","on","on-intersect","on-interval","on-signal-patch","on-signal-patch-filter",
  "preserve-attr","ref","show","signals","style","text",
  // Pro — allowed so a Pro page does not trip the check, but flagged separately.
  "animate","custom-validity","match-media","on-raf","on-resize","persist",
  "query-string","replace-url","scroll-into-view","view-transition",
]);
const PRO = new Set(["animate","custom-validity","match-media","on-raf","on-resize",
  "persist","query-string","replace-url","scroll-into-view","view-transition"]);
const MODIFIERS = new Set([
  "once","passive","capture","debounce","throttle","window","document","outside",
  "prevent","stop","viewtransition","delay","self","duration","threshold","half",
  "full","exit","leading","notrailing","case","filter","history","focus",
]);

const kebabToCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// Levenshtein, so we only flag a name that is plausibly a typo of a real
// attribute. An application's own data-* attributes (data-sp-theme here) are
// nowhere near one, and must not be reported.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[a.length][b.length];
}
const nearestAttr = (name) => {
  let best = null, bestD = Infinity;
  for (const a of ATTRS) { const d = editDistance(name, a); if (d < bestD) { bestD = d; best = a; } }
  return { best, dist: bestD };
};
const problems = [];
const add = (file, line, code, msg) => problems.push({ file, line, code, msg });

async function files(dir, exts) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!["node_modules",".git"].includes(e.name)) out.push(...await files(join(dir, e.name), exts)); }
    else if (exts.some((x) => e.name.endsWith(x))) out.push(join(dir, e.name));
  }
  return out;
}

const declared = new Set();
const used = [];       // {name, file, line}
const idsBy = {};        // language -> Map<id, {file,line}>
const templateIds = new Set();
const templateIdsFromHtml = new Set();

for (const f of await files(".", [".html", ".go", ".ts"])) {
  if (f.includes("datastar.js") || f.endsWith("check-datastar.mjs")) continue;
  const src = await readFile(f, "utf8");
  const lines = src.split("\n");

  lines.forEach((text, i) => {
    const ln = i + 1;

    // --- 1/2/3: attribute names, keys and modifiers ---
    for (const m of text.matchAll(/\bdata-([a-z-]+)((?::(?:[A-Za-z0-9-]|_(?!_))+)?)((?:__[A-Za-z0-9_.-]+)*)/g)) {
      const [, name, key, mods] = m;
      if (name === "signals" || ATTRS.has(name)) {
        if (PRO.has(name)) add(f, ln, "PRO", `\`data-${name}\` is a Datastar Pro attribute`);
      } else {
        const { best, dist } = nearestAttr(name);
        // Only a near-miss is a typo. Anything further away is the app's own
        // data-* attribute and none of our business.
        if (dist > 0 && dist <= 2)
          add(f, ln, "UNKNOWN-ATTR",
            `unknown attribute \`data-${name}\` — did you mean \`data-${best}\`? ` +
            `An unrecognised name is silently ignored at runtime`);
      }
      if (key) {
        const k = key.slice(1);
        if (/[A-Z]/.test(k))
          add(f, ln, "KEY-CASE", `\`data-${name}:${k}\` — HTML lowercases attribute names, so this creates ` +
            `the signal \`$${k.toLowerCase()}\`, not \`$${k}\`. Use kebab-case: \`data-${name}:${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}\``);
        if (["bind","computed","indicator","ref","signals"].includes(name)) declared.add(kebabToCamel(k));
      }
      for (const mod of mods.split("__").filter(Boolean)) {
        const base = mod.split(".")[0];
        if (!MODIFIERS.has(base))
          add(f, ln, "UNKNOWN-MOD", `unknown modifier \`__${base}\` on data-${name} — silently ignored, ` +
            `so the behaviour you asked for never happens`);
      }
    }

    // --- 4: signals declared in object literals, on both sides of the wire ---
    for (const m of text.matchAll(/data-signals="\{([^"]*)\}"/g))
      for (const k of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) declared.add(k[1]);
    for (const m of text.matchAll(/signals\(`?\{([^`"}]*)\}/g))          // server: s.signals("{a: ''}")
      for (const k of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) declared.add(k[1]);
    for (const attr of text.matchAll(/\bdata-(?:[a-z-]+)(?::(?:[A-Za-z0-9-]|_(?!_))+)?(?:__[A-Za-z0-9_.-]+)*="([^"]*)"/g))
      for (const m of attr[1].matchAll(/\$([A-Za-z_][\w]*)/g))
        used.push({ name: m[1], file: f, line: ln });

    // --- 5: element ids, bucketed by where they come from ---
    for (const m of text.matchAll(/<[a-z]+[^>]*\bid="([A-Za-z][\w-]*)"/g)) {
      templateIds.add(m[1]);
      if (f.endsWith(".html")) templateIdsFromHtml.add(m[1]);
      const bucket = f.endsWith(".go") ? "go" : f.endsWith(".ts") ? "ts" : "html";
      (idsBy[bucket] ??= new Map()).set(m[1], { file: f, line: ln });
    }
  });
}

// Signals the server sets or the page reads must exist somewhere.
const ignore = new Set(["evt","el","ctx"]);
for (const u of used)
  if (!declared.has(u.name) && !ignore.has(u.name))
    add(u.file, u.line, "UNDECLARED-SIGNAL",
      `\`$${u.name}\` is read but never declared — Datastar renders it as empty with no error`);

// The Go port is frozen at four features while TypeScript moves ahead, so the
// two are no longer expected to render the same set of ids. Only one direction
// still means something: every id the frozen Go port renders must still be
// rendered by TypeScript, or a shared feature has drifted apart. Ids that exist
// only in TypeScript are new features and are not drift.
const go = idsBy.go ?? new Map(), ts = idsBy.ts ?? new Map();
if (go.size && ts.size)
  for (const [id, at] of go)
    if (!ts.has(id) && !templateIdsFromHtml.has(id))
      add(at.file, at.line, "ID-DRIFT",
        `#${id} is rendered by the frozen Go port but no longer by TypeScript — a shared feature has drifted`);

const seen = new Set();
const uniq = problems.filter((p) => { const k = `${p.file}:${p.line}:${p.code}:${p.msg}`; if (seen.has(k)) return false; seen.add(k); return true; });
const errors = uniq.filter((p) => p.code !== "PRO");

for (const p of uniq) console.log(`  ${p.code === "PRO" ? "note " : "ERROR"}  ${p.file}:${p.line}  ${p.msg}`);
console.log(errors.length
  ? `\n${errors.length} problem(s) Datastar would not have told you about.`
  : `\nNo Datastar attribute problems found. (${declared.size} signals declared, ${templateIds.size} patch targets.)`);
process.exit(errors.length ? 1 : 0);

// Schema migration for the lab, run from the RUNTIME library rather than the
// CLI.
//
// `bunx @better-auth/cli` resolves its own bundled copy of better-auth — latest
// stable is 1.4.21, while this lab runs 1.7.2 — so the CLI generated a schema
// missing `account.issuer`, which 1.7 requires, and every sign-up died with
// "table account has no column named issuer". Calling `getMigrations` from the
// installed library removes the skew by construction: the plan can only ever
// come from the version that will serve the requests.
import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth.ts";

const { toBeCreated, toBeAdded, toBeAddedIndexes, unsafeChanges, runMigrations } =
  await getMigrations((auth as any).options, { throwOnUnsafe: false });

for (const t of toBeCreated) console.log("create table", t.table, Object.keys(t.fields).join(", "));
for (const t of toBeAdded) console.log("add columns ", t.table, Object.keys(t.fields).join(", "));
for (const i of toBeAddedIndexes) console.log("add index  ", i.table, i.name);
for (const u of unsafeChanges) console.log("UNSAFE     ", u);

if (unsafeChanges.length) {
  console.error("\nRefusing to migrate: the changes above need a backfill first.");
  process.exit(1);
}

await runMigrations();
console.log("\nmigrated");

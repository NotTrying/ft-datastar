// better-auth for the CLI only, on Node. Same options, node:sqlite instead of
// bun:sqlite, because the CLI cannot load a config that imports bun:sqlite.
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { options } from "./auth-options.ts";

export const auth = betterAuth({
  ...options,
  database: new DatabaseSync(process.env.LAB_DB ?? "better-auth.db"),
});

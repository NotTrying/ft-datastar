// better-auth at RUNTIME, on Bun. See auth-options.ts for why the CLI needs
// its own entry point.
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { options } from "./auth-options.ts";

export const auth = betterAuth({
  ...options,
  database: new Database(process.env.LAB_DB ?? "better-auth.db"),
});

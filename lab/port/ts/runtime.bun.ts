// The Bun implementation of the runtime seam. Imported only by main.ts, so
// `bun:sqlite` never reaches a Workers bundle.
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { setRuntime, type SqliteLike } from "./runtime.ts";

const SHARED = process.env.LAB_SHARED ?? "../shared";

setRuntime({
  openDatabase: (path) => new Database(path) as unknown as SqliteLike,
  readAsset: async (name) =>
    name.endsWith(".html")
      ? await readFile(`${SHARED}/${name}`, "utf8")
      : (await readFile(`${SHARED}/${name}`)).buffer as ArrayBuffer,
  env: (key) => process.env[key],
  // Bun ships argon2id; nothing to install.
  hashPassword: (pw) => Bun.password.hash(pw),
  verifyPassword: (pw, hash) => Bun.password.verify(pw, hash).catch(() => false),
});

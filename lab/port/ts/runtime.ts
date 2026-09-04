// The three places this port touches its host, behind one seam.
//
// Everything else in the port is web-standard and runs anywhere. These are
// not: opening a database, reading a static file, and hashing a password. Bun
// has all three built in, which is why the port has no dependencies; Cloudflare
// Workers has none of them in that form. Rather than fork 2,800 lines for a
// second target, each is resolved through this slot, installed once at startup
// by whichever entry point is running (`main.ts` for Bun, `worker/entry.ts`
// inside a Durable Object).
//
// The Bun implementation lives in `runtime.bun.ts`, not here, so that this
// module — imported by store.ts, auth.ts and server.ts — never pulls
// `bun:sqlite` into a bundle that cannot resolve it.

/** The `bun:sqlite` surface this port actually uses: a prepared statement with
 *  three ways to consume it. The generics mirror bun:sqlite's exactly, so every
 *  existing call site keeps its row and parameter types unchanged — the seam
 *  costs the store nothing in type safety. */
export interface Statement<R, P extends unknown[]> {
  all(...params: P): R[];
  get(...params: P): R | null;
  run(...params: P): { changes: number };
}
export interface SqliteLike {
  query<R = unknown, P extends unknown[] = unknown[]>(sql: string): Statement<R, P>;
  run(sql: string): void;
}

export interface Runtime {
  openDatabase(path: string): SqliteLike;
  /** Static asset by file name, e.g. "dashboard.html", "datastar.js".
   *  Returns a body a Response can take directly. */
  readAsset(name: string): Promise<ArrayBuffer | string>;
  env(key: string): string | undefined;
  hashPassword(pw: string): Promise<string>;
  verifyPassword(pw: string, hash: string): Promise<boolean>;
}

let installed: Runtime | null = null;

export function setRuntime(r: Runtime): void {
  installed = r;
}

export function rt(): Runtime {
  if (!installed) {
    throw new Error(
      "No runtime installed. Import an entry point (main.ts on Bun, " +
        "worker/entry.ts on Workers) rather than server.ts directly.",
    );
  }
  return installed;
}

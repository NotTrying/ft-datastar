// A `bun:sqlite`-shaped view of a Durable Object's SQLite storage.
//
// This is the whole reason the port runs on Workers unchanged. D1 is async, so
// backing the Store with it would mean making all ~65 store methods async and
// awaiting at every call site across thirteen files — a large mechanical edit
// to the one thing whose value is that it is verified. A Durable Object's
// SQLite storage is SYNCHRONOUS, exactly like bun:sqlite, so the same store
// code runs on both with only its constructor changed.
import type { SqliteLike, Statement } from "../ts/runtime.ts";

/** The slice of Cloudflare's SqlStorage this shim needs. */
export interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/**
 * Takes a getter, not a handle. server.ts builds its Store once at module
 * scope, but a module lives in the isolate and a Durable Object does not: the
 * runtime can tear an object down and construct a new one while the module —
 * and the Store holding its storage handle — survives. Cloudflare then refuses
 * the stale handle outright ("Cannot perform I/O on behalf of a different
 * Durable Object"), which is how this was found. Resolving the handle per call
 * means the long-lived Store always talks to the live object.
 */
export function sqliteOverDurableObject(current: () => SqlStorage): SqliteLike {
  const changes = () => Number(current().exec("SELECT changes() AS c").toArray()[0]!.c);

  return {
    query<R, P extends unknown[]>(text: string): Statement<R, P> {
      return {
        all: (...params: P) => current().exec(text, ...params).toArray() as R[],
        get: (...params: P) => (current().exec(text, ...params).toArray()[0] ?? null) as R | null,
        run: (...params: P) => {
          current().exec(text, ...params).toArray();
          return { changes: changes() };
        },
      };
    },
    run(text: string) {
      // PRAGMAs are a connection setting bun:sqlite needs and a Durable Object
      // does not — it owns its database exclusively, so there is no busy
      // timeout to set and SQLite rejects the statement outright.
      if (/^\s*PRAGMA\b/i.test(text)) return;
      // exec() takes one statement at a time when bindings are possible; the
      // schema arrives as a script, so split it. Semicolons inside string
      // literals would break this — the schema has none, and a schema that
      // grew one would fail loudly here rather than silently.
      for (const stmt of text.split(";")) {
        if (stmt.trim()) current().exec(stmt);
      }
    },
  };
}

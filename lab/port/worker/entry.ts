// Cloudflare Workers entry point for the Datastar port.
//
// The whole application lives inside ONE Durable Object. That is not an
// architectural flourish, it is the reason no application code changed: a
// Durable Object's SQLite storage is synchronous, matching bun:sqlite, whereas
// D1 is async and would have forced every one of the store's ~65 methods — and
// every call site in thirteen files — to become async. The Worker in front is a
// forwarder and nothing else.
//
// Consequences worth being honest about: one object means one thread and one
// database, so this is a demo, not a shape to scale a real tenant load on.
import { setRuntime } from "../ts/runtime.ts";
import { sqliteOverDurableObject, type SqlStorage } from "./sqlite-do.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { ASSETS_GZIP_BASE64 } from "./assets.ts";

interface Env {
  APP: DurableObjectNamespace;
  LAB_DEV?: string;
}

// The live Durable Object's SQLite handle. Module scope, because the modules
// below it (server.ts and its Store) are cached per isolate and outlive any one
// object; every read goes through here so a rebuilt object cannot leave a stale
// handle behind. See sqlite-do.ts.
let liveSql: SqlStorage | null = null;

/** Inflate the gzipped asset bundle once, on first use. */
let assets: Promise<Record<string, string>> | null = null;
function loadAssets(): Promise<Record<string, string>> {
  assets ??= (async () => {
    const gz = Uint8Array.from(atob(ASSETS_GZIP_BASE64), (c) => c.charCodeAt(0));
    const stream = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text()) as Record<string, string>;
  })();
  return assets;
}

export class App {
  private app: Promise<{ fetch(req: Request): Promise<Response> }> | null = null;

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {
    setRuntime({
      openDatabase: () =>
        sqliteOverDurableObject(() => {
          if (!liveSql) throw new Error("No Durable Object storage bound for this request");
          return liveSql;
        }),
      readAsset: async (name) => {
        const body = (await loadAssets())[name];
        if (body === undefined) throw new Error(`No such asset: ${name}`);
        return body;
      },
      env: (key) => (this.env as unknown as Record<string, string | undefined>)[key],
      hashPassword,
      verifyPassword,
    });
  }

  async fetch(req: Request): Promise<Response> {
    // Rebind before anything can touch the database: this object may be a
    // replacement for one whose handle the cached modules are still holding.
    liveSql = this.ctx.storage.sql;
    // Imported lazily and only once: server.ts opens the database and seeds it
    // at module scope, which can only happen inside a Durable Object, never at
    // isolate startup. The promise is cached, so a burst of concurrent first
    // requests still seeds exactly once.
    this.app ??= import("../ts/server.ts").then((m) => m.default);
    return (await this.app).fetch(req);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return env.APP.get(env.APP.idFromName("singleton")).fetch(req);
  },
};

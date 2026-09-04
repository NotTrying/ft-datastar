# The port, on Cloudflare Workers

`../ts` runs on Bun against a SQLite file. This runs the same code on Workers,
so there is something deployed to click through. **No application logic was
rewritten**: thirteen of the fourteen files are byte-identical to the Bun build,
and the port's whole verification suite — 128 assertions — passes against
`workerd`.

**Live:** https://datastar-port.azvk.workers.dev — sign in with
`owner@example.com` / `correct-horse-battery`.

## Build and run

```sh
bun build.ts                       # freeze ../shared into a module, bundle
npx wrangler dev --local --port 8110
```

Deploy needs `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit) in the environment:

```sh
npx wrangler deploy
```

## Why a Durable Object rather than D1

D1 is asynchronous. Backing the store with it would mean making all ~65 `Store`
methods async and awaiting at every call site across thirteen files — a large
mechanical edit to the one part of this project whose value is that it is
verified. A Durable Object's SQLite storage is **synchronous**, the same shape
as `bun:sqlite`, so `store.ts` runs on both with only its constructor changed.

The cost is honest: one object is one thread and one database. Fine for a demo,
not a shape to scale real tenants on.

## The three host seams

`../ts/runtime.ts` names them, because everything else in the port is
web-standard and runs anywhere:

| seam | Bun | Workers |
|---|---|---|
| database | `bun:sqlite` | `sqlite-do.ts` over `ctx.storage.sql` |
| static files | `node:fs` reads `../shared` | `assets.ts`, gzipped into the bundle |
| password hashing | `Bun.password` (argon2id) | `password.ts` (PBKDF2 via WebCrypto) |

## Two bugs only Workers found

Both were caught by running the suite against `workerd` locally, before
deploying anything.

**A stale Durable Object handle.** `server.ts` builds its `Store` once at module
scope, but a module lives in the isolate and a Durable Object does not: the
runtime can tear an object down and construct a new one while the module — and
the handle it is holding — survives. Cloudflare refuses the stale handle
outright ("Cannot perform I/O on behalf of a different Durable Object"). The
shim now takes a *getter* and resolves the live handle per call.

**Ordering on a timestamp is not a total order.** Workers freezes `Date.now()`
within a request, so every row a single request writes shares a timestamp
exactly, and SQLite is then free to return tied rows in any order — the same
query returned a different first row on consecutive calls. Every `ORDER BY` in
`store.ts` now carries `id` as a final tiebreaker. On Bun the clock advances
between inserts, which is why nothing here ever failed on Bun; the fragility was
always in the code, and only a different clock exposed it.

## The demo is seeded and dev-gated

`LAB_DEV=1` is set, which exposes `/dev/*` routes (seed a user, read the last
OTP, drive the liveness sweep, stub the avatar and oEmbed upstreams). The
verification suites drive the app through them and every row is fabricated. It
is a demo, not a tenant: do not put anything real in it, and turn `LAB_DEV` off
if it ever needs to be more than that.

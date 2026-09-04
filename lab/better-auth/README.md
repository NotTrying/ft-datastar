# Datastar + better-auth

The experiment that decides whether social-proof could migrate its view layer
to Datastar without rewriting its authentication.

The port (`../port`) hand-rolls sessions and organisations, which proves the
Datastar side works but says nothing about the real question: social-proof's
auth is better-auth, and a migration is only tractable if better-auth mounts
unchanged behind a hypermedia transport. So this is not a rewrite of the port —
it is 183 lines of server whose only job is to make better-auth and Datastar
share a request.

Run it: `./check.sh` — typecheck, a schema migrated from the installed library,
then 15 browser assertions against a fresh database.

## What it establishes

**better-auth mounts in one line.** `if (p.startsWith("/api/auth/")) return
auth.handler(req)` is the whole integration for its own endpoints. The rest of
the app reads the session server-side with `auth.api.getSession({ headers })`,
so the browser never holds a token — the same shape as SvelteKit's `locals`,
without SvelteKit.

**Set-Cookie composes with SSE, in TypeScript.** Sign-in returns an event
stream, and better-auth sets its session cookie on its own `Response`. Because
a `Response` is constructed with its headers, the cookie can be lifted onto the
stream:

```ts
const res = await auth.api.signInEmail({ body, asResponse: true });
return sseRedirect("/", res.headers);   // headers.getSetCookie() → appended
```

This is the header-before-stream trap that made the Go port set the cookie
*before* opening the stream. It cannot arise here. That difference is the
strongest single argument for the TypeScript backend over Go.

**The organisation plugin covers what the port hand-rolled.** `createOrganization`,
`setActiveOrganization`, `listOrganizations`, `createInvitation`,
`cancelInvitation`, `acceptInvitation`, `getFullOrganization` — the same
surface, already written.

**Membership is re-checked per request.** The port had a bug where a removed
member kept reading the org because the session pinned `activeOrganizationId`.
better-auth's org routes call `findMemberByOrgId` on every request (38 such
checks across its routes), so the same class of bug is not reachable. The
session cookie is a pointer at a database row, not the state itself, which is
why switching organisations does not rewrite it — asserted explicitly in the
suite so the property is not mistaken for a missing patch.

## What it cost

23 packages, 33 MB, against the port's zero runtime dependencies. That is the
trade: the port is smaller and entirely legible; this is smaller *to write* and
maintained by someone else.

## Three traps worth writing down

**The CLI is a different version from the library.** `bunx @better-auth/cli@latest`
resolves its own bundled better-auth — latest stable 1.4.21 against this lab's
1.7.2 — so it generated a schema with no `account.issuer` and every sign-up died
with `table account has no column named issuer`. `migrate.ts` calls
`getMigrations` from the *installed* library instead, which removes the skew by
construction. There is no version of this problem that a lockfile fixes.

**The CLI cannot load a config that imports `bun:sqlite`.** It runs under Node
via jiti. Hence three files where there should be one: shared options with no
database, a Bun runtime entry, a Node CLI entry. With `migrate.ts` the CLI entry
is no longer needed, but it is kept because the split is the thing worth
remembering.

**`as const` on the options silently empties `auth.api`.** It makes `plugins` a
readonly tuple, which does not satisfy `BetterAuthPlugin[]`, so better-auth
falls back to the pluginless API type and every organisation method disappears
from the type surface while the runtime keeps working. `tsc --noEmit` catches
it; a bun-only workflow would not. That is why `check.sh` runs it first.

## And one finding about the real app

Comparing this schema against social-proof's showed its hand-maintained Drizzle
schema had drifted from better-auth 1.7: `invitation.created_at` was missing,
and better-auth's Drizzle adapter throws rather than dropping a field it cannot
place — so inviting a team member failed in production. Fixed on the
`fix/auth-schema-drift` branch there, with a test that compares the two schemas
so it cannot drift again.

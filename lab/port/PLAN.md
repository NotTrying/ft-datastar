# Overnight build plan

**State lives in this file.** The container is ephemeral and is re-cloned on each firing, so
the checklist below — not memory — is the source of truth. Tick items as they land.

Scheduled by the user (Sydney, UTC+10) to run from 09:41 their time. Decisions they made:

- **TypeScript only from here.** The Go port is FROZEN at four features — do not extend it.
  Both Go-vs-TS findings (the attribute-casing bug that Go's case-insensitive JSON hid, and
  the Set-Cookie-before-SSE ordering bug that cannot exist in the Response model) came from
  the first two features; scan and embed produced none. The size ratio is settled at 22–42%.
  The differential-testing benefit that caught the casing bug is now covered statically by
  check-datastar.mjs. And every remaining feature is the better-auth surface — organizations,
  invitations, admin, sessions — which in Go would mean hand-rolling a system that can never
  ship, since Go cannot run on Cloudflare Workers. Frozen, not deleted: check.sh still runs
  the four original suites against Go so it cannot rot.
- **Depth first**: finish the member app properly, with tests. Marketing/SEO pages are out of scope.
- **Skip billing entirely.** No Stripe. Skip `dashboard/billing` and `admin/subscriptions`.
- They will check back after a few hours.

## How to work each item

1. Read the SvelteKit original in `/home/user/social-proof` first. Port faithfully —
   same validation, same messages, same security posture. Note any bug found in the
   original rather than silently fixing it.
2. Implement in **`ts/` only**. Do not touch `go/`.
3. Add browser assertions to the matching `verify-*.mjs` (new suite if the feature is new).
4. Run `./check.sh`. It must be fully green. New suites run against TypeScript only; the four
   original suites still run against both, and must keep passing.
5. Commit with a descriptive message and **push** to `claude/datastar-framework-hj2jw9`.
6. Tick the item here, commit that too.

Never leave the branch red. One finished item pushed beats three half-done.

## Rules that already hold (do not regress)

- No GET may mutate — a GET is CORS-simple and carries every signal in its query string.
- Set headers **before** opening an SSE stream, or `Set-Cookie` is silently dropped.
- Kebab-case in attribute keys: `data-bind:author-name` → `$authorName`.
- Nothing sensitive in a signal; use `@post(..., {contentType:'form'})` for passwords.
- The embed (`/embed/{id}`) ships **no Datastar** and must stay that way.
- Escape all user content on the way out.

## Note for when the user is awake — do not act on this unattended

The realistic migration keeps **better-auth**, which is framework-agnostic and runs on
Workers. Orgs, invitations, admin and session management below are exactly its plugin
surface, so a production port would mount `auth.handler(request)` rather than hand-roll them.
Hand-rolling is still the right thing to do overnight: it is the like-for-like port, it is
low-risk unattended, and the interesting question is the **Datastar UI** for member lists,
role changes and invite flows — not where the rows are stored. Keep the auth storage minimal
and spend the effort on the interaction layer. Flag better-auth for a decision with the user.

## Checklist

### 1. Profile settings — `dashboard/settings` — DONE
- [x] Port `settings/+page.server.ts` (269) + `+page.svelte` (402)
- [x] Change display name; change email via the three-step OTP flow
- [x] Sessions list, revoke one, "sign out everywhere"
- [x] Browser suite `verify-settings.mjs` (22 assertions)

Two items in the original version of this list were wrong and have been dropped:

- **No password change on this page.** The original settings page has five actions
  (updateProfile, verifyCurrentEmail, verifyEmailChange, revokeSession,
  revokeOtherSessions) and none of them touch passwords.
- **No self-serve account deletion, deliberately.** The original ends with a comment
  explaining it: deletion is admin-only so it runs the `user.delete` databaseHook that
  cancels the org's Stripe subscription. A raw delete would leave a paying org billed after
  the user is gone. `user-cleanup.ts` belongs to the admin path, not here. Preserved.

### 2. Organizations — `dashboard/settings/organization` + invites — DONE
- [x] Port `organization/+page.server.ts` (56) + `+page.svelte` (260)
- [x] Port `org-bootstrap.ts` (90): every user gets an org on first login
- [x] Members list, roles, remove member, org switching
- [x] Create + revoke invites; accept/decline flow at `/invite/{id}`
- [x] **Scope walls/handles/testimonials to the active org, not just the user** — done.
      Testimonials, handles, walls and the scan log now key off `org_id`; `user_id` stays on
      the row as the author. The dedupe indexes moved with them. Sessions and accounts remain
      user-scoped, which is correct.
- [x] Browser suite `verify-org.mjs` (20 assertions)

Transfer-ownership is not in the original and was dropped from this list.

### 3. Admin — `admin/*` — DONE
- [x] Admin-only gate, re-checked on every admin route rather than once
- [x] Port `admin/users/+page.server.ts` (114) + `+page.svelte` (255): list, ban/unban, delete
- [x] Admin overview counts (users, banned) in the page header
- [x] A non-admin gets 403 on the page AND on the mutations — asserted
- [x] Browser suite `verify-admin.mjs` (17 assertions)
- [x] SKIPPED `admin/subscriptions` (Stripe), as agreed

Impersonation exists in the original's plugin list but is not used by the page, so it is not
ported. Deletion here does the data half only — the original routes it through better-auth so
the `user.delete` hook can cancel the org's Stripe subscription, and billing is out of scope.

### 4. Avatar proxy — `api/v1/avatar/[id]` — DONE
- [x] Ported. Takes a testimonial id, never a user-supplied URL (SSRF).
- [x] Wired into the wall renderer, replacing the initials fallback when an avatar exists
- [x] Asserted: every wall image points at our own proxy, none at a third-party host
- [x] Browser suite `verify-avatar.mjs` (13 assertions)

### 5. Liveness — `lib/server/liveness.ts` — DONE
- [x] Ported (163). `verify_state` is now real rather than stubbed as `'unknown'`.
- [x] A testimonial whose original is gone stops rendering on the wall — asserted
- [x] `unknown` is never treated as a negative signal, and writes nothing at all
- [x] Browser suite `verify-liveness.mjs` (11 assertions, includes health)

### 6. Health — `api/health` — DONE
- [x] Ported, with per-check reporting and 503 when unhealthy.

## When the checklist is complete

Delete the Routine (`mcp__Claude_Code_Remote__list_triggers` → `delete_trigger`) so it does
not fire again tomorrow, and leave a short summary as the final commit.

## Progress log

**ALL ITEMS COMPLETE — please pause this Routine.** Every checklist item above is done and
the gate is green at 201 assertions across two consecutive runs. The Routine is a daily cron
and will fire again tomorrow morning unless paused; this run has no MCP tools and cannot
delete it.

Append one line per firing: what was attempted, what landed, what broke.

- **Run 1 (23:41Z)** — Item 1 done: profile settings, three-step email OTP, session
  management. 22 new assertions; gate green at 134 total. Three things worth recording:
  (a) declaring a signal in `data-signals` that a `data-bind` input also owns silently
  BLANKS the server-rendered `value` — the declaration wins and is written into the element;
  let the input own its own signal. (b) `maxlength` and `type="email"` mean the browser
  blocks bad input before Datastar sees it, so client guard and server rule need separate
  assertions — the server rule is the one that matters. (c) the ID-DRIFT check in
  check-datastar.mjs narrowed now that Go is frozen; the browser suites cover what it lost,
  verified by injecting a renamed patch target. Suites now report progress on crash.
- **Run 1 (cont.)** — Item 2 mostly done: personal-org bootstrap, members, roles,
  invitations with accept/decline, org switching. 20 assertions, all green first try; gate
  at 154. Found and fixed a real leak while writing it: the active org is pinned on the
  session, so a REMOVED member kept reading the org they had been removed from until they
  signed out. `activeOrgFor` now re-checks membership on every request and falls back.
  Also worth recording: in the SvelteKit original every mutation on this page is a
  client-side RPC call into better-auth (`authClient.organization.*`); under Datastar they
  are all ordinary server routes and the browser makes no API calls of its own.
  REMAINING for the next run: scope walls/handles/testimonials to the active org.
- **Run 2 (00:41Z)** — Item 2 finished: every data table now keys off `org_id` rather than
  `user_id`, with `user_id` kept as the author. 22 queries and every call site converted;
  `tsc` located all nine call sites, which is the argument for the strict config. Six new
  assertions prove the scoping actually works (a new org starts empty, an accepted member
  sees the org's rows, switching restores them). Gate at 160.
  Two test-quality problems fixed rather than papered over: (a) suites share ONE database in
  check.sh, so assertions must be relative — `[2,2,1]` held standalone but not after the
  earlier suites had added, approved and deleted rows; (b) a genuine race — the org switcher
  redirects via a patched `<script>` back to the page it is already on, so `waitForURL`
  resolves instantly and the next navigation aborts the redirect mid-flight. Waiting on the
  real `load` event fixed it; verified across two consecutive full runs, since one green run
  proved nothing here. check.sh now surfaces CRASH lines, not just FAIL.
- **Run 2 (cont.)** — Item 3 done: admin gate, user list, ban/unban, delete. 17 assertions,
  green first try; gate at 177 across two consecutive runs. The gate is re-checked on every
  admin route rather than once, keeping the original's discipline — it warns that SvelteKit
  form actions do not run the layout `load`, so a single gate would have left the mutations
  open. Banning ends the target's sessions and refuses them at sign-in, so it bites at once
  instead of waiting for a cookie to expire; asserted both ways. Deleting a user also removes
  memberships and any org left with no members, rather than leaving orphaned rows owning
  testimonials nobody can reach. One test-infrastructure fix: the admin suite deletes an
  account, so it now mints a disposable one through a dev-gated route instead of consuming a
  seeded account the org and settings suites depend on — suites share one database.
- **Run 3 (02:41Z / 03:41Z)** — Items 4, 5 and 6 done; checklist complete. Avatar proxy
  (13 assertions), liveness + health (11), gate at 201 across two consecutive runs.
  Notes worth keeping: this container cannot reach the public internet from Bun's fetch, so
  both the avatar CDN and X's oEmbed are exercised through dev-gated stub upstreams — every
  security check still runs against them (https-only, type allowlist, size cap, header
  pinning), only the network is faked. Three test-quality problems fixed rather than papered
  over: a suite reused a wall an earlier suite had PAUSED (both now create their own); the
  liveness sweep orders by `last_verified_at`, not `posted_at`, so the dev hook had to park
  the other rows to make its target the one picked; and one assertion wrongly demanded
  `checked === 0` after a retirement, when the sweep correctly moves on to other rows.
  Also confirmed by accident, then asserted deliberately: a Google review returns `unknown`
  and is never retired, because there is no reliable liveness check for that platform.

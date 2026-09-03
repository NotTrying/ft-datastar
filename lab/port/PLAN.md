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

### 2. Organizations — `dashboard/settings/organization` + invites
- [ ] Port `organization/+page.server.ts` (56) + `+page.svelte` (260)
- [ ] Port `org-bootstrap.ts` (90): every user gets an org on first login
- [ ] Members list, roles, remove member, transfer ownership
- [ ] Create + revoke invites; accept flow at `/invite/{token}` (public route, 49)
- [ ] Scope walls/handles/testimonials to the active org, not just the user
- [ ] Browser suite `verify-org.mjs`

### 3. Admin — `admin/*`
- [ ] Port `admin/+layout.server.ts` (17): admin-only gate, distinct from the member gate
- [ ] Port `admin/users/+page.server.ts` (114) + `+page.svelte` (255): list, search, ban/unban, impersonate if present
- [ ] Admin overview `admin/+page.svelte` (35) with real counts
- [ ] A non-admin must get 403/redirect — assert it
- [ ] Browser suite `verify-admin.mjs`
- [ ] SKIP `admin/subscriptions` (Stripe)

### 4. Avatar proxy — `api/v1/avatar/[id]`
- [ ] Port (74). Takes a testimonial id, never a user-supplied URL.
- [ ] Wire into the wall renderer (`sp-avatar`), replacing the initials fallback when present
- [ ] Assert a wall visitor's IP never reaches the platform CDN (no third-party img src)

### 5. Liveness — `lib/server/liveness.ts`
- [ ] Port (163). This fills in `verify_state`, currently stubbed as `'unknown'`.
- [ ] A testimonial whose original is gone stops rendering on the wall — assert it
- [ ] `unknown` is never treated as a negative signal

### 6. Health — `api/health`
- [ ] Port. Cheap, do it whenever there is a spare moment.

## When the checklist is complete

Delete the Routine (`mcp__Claude_Code_Remote__list_triggers` → `delete_trigger`) so it does
not fire again tomorrow, and leave a short summary as the final commit.

## Progress log

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

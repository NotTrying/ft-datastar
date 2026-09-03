# Overnight build plan

**State lives in this file.** The container is ephemeral and is re-cloned on each firing, so
the checklist below — not memory — is the source of truth. Tick items as they land.

Scheduled by the user (Sydney, UTC+10) to run from 09:41 their time. Decisions they made:

- **Depth first**: finish the member app properly, with tests. Marketing/SEO pages are out of scope.
- **Skip billing entirely.** No Stripe. Skip `dashboard/billing` and `admin/subscriptions`.
- They will check back after a few hours.

## How to work each item

1. Read the SvelteKit original in `/home/user/social-proof` first. Port faithfully —
   same validation, same messages, same security posture. Note any bug found in the
   original rather than silently fixing it.
2. Implement in **both** backends: `go/` and `ts/`, sharing HTML in `shared/`.
3. Add browser assertions to the matching `verify-*.mjs` (new suite if the feature is new).
4. Run `./check.sh`. It must be fully green — gofmt, go vet, tsc, check-datastar, and every
   browser suite on both backends.
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

## Checklist

### 1. Profile settings — `dashboard/settings`
- [ ] Port `settings/+page.server.ts` (269) + `+page.svelte` (402)
- [ ] Change display name; change email; change password (re-auth with current password)
- [ ] Delete account, including the `user-cleanup.ts` (84) cascade
- [ ] Sessions list + "sign out everywhere"
- [ ] Browser suite `verify-settings.mjs`

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

- (no firings yet)

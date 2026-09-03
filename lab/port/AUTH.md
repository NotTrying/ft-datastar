# Authentication with Datastar

## The short answer: Datastar says nothing about auth

There is no auth section in the guide, no auth how-to, and the
[Security reference](https://data-star.dev/reference/security) covers only XSS,
expression evaluation and CSP. It does not mention CSRF or sessions at all.

That is not an oversight — Datastar is a hypermedia layer, not a framework. **Auth is
entirely your backend's problem, exactly as it would be in a server-rendered app with no
frontend framework.** Whatever your language already does for sessions still applies.

What *does* change is three Datastar-specific wrinkles, all of which bit us here.

## Wrinkle 1 — a 302 cannot redirect an SSE request

The single most important one. When a session expires mid-interaction, the natural server
reflex is `302 → /login`. That silently fails: `fetch` follows the redirect and hands
Datastar the login **page** as if it were an event stream. Nothing happens; the user
clicks again.

The documented mechanism is to patch a `<script>` into the body:

```
event: datastar-patch-elements
data: selector body
data: mode append
data: elements <script>setTimeout(() => window.location = "/login")</script>
```

`setTimeout` is not decoration — without it Firefox *replaces* the URL rather than pushing
it, and the back button breaks.

So every guard needs two paths — which is what `requireUser` does in both ports:

```go
if isDatastar(r) { sseRedirect(w, "/login"); return }  // SSE: script patch
http.Redirect(w, r, "/login", http.StatusFound)        // plain nav: ordinary 302
```

## Wrinkle 2 — headers must be set before the stream opens

A real bug this port hit. Login succeeded, the redirect fired, and the user landed back on
`/login` because **`Set-Cookie` never shipped**:

```go
s, ok := newSSE(w)              // flushes response headers HERE
...
setSessionCookie(w, r, tok, exp) // too late: silently dropped
```

Authenticate and set the cookie *first*, open the stream *second*.

Worth noting: **this bug is unrepresentable in the TypeScript port.** A `Response` is
constructed with its headers, so there is no window in which the stream is open but the
headers are not yet written. The Go `http.ResponseWriter` model — write headers, then
stream — is what creates the trap. If you are on Workers/Bun this class of bug cannot
happen to you.

## Wrinkle 3 — never put a password in a signal

From the docs: *"signal values are visible in the source code in plain text, and can be
modified by the user before being sent in requests."*

Worse than that, and undocumented: **every signal on the page is sent with every request.**
Captured off the wire, a `PATCH /testimonials/{id}` carries the whole form:

```
PATCH /testimonials/3f387820…?status=approved
  content-type: application/json
  datastar-request: true
  body: {"tab":"pending","content":"","authorName":"","authorHandle":"","sourceUrl":"","postedAt":""}
```

A `data-bind:password` would therefore be posted to every endpoint the page touches, for as
long as the page lives. The fix is to keep it out of the signal store entirely:

```html
<form data-on:submit__prevent="@post('/login', {contentType: 'form'})">
  <input type="password" name="password">   <!-- no data-bind -->
```

`contentType: 'form'` sends the form's own fields instead of the signal store. Use
`filterSignals` for the same reason on any endpoint where the default payload is more than
it needs.

## CSRF

Measured, not assumed. Every Datastar request carries `datastar-request: true`, and every
non-GET carries `content-type: application/json`. Neither is a CORS *simple request*, so a
cross-origin page cannot make the browser send one without a preflight your server never
approves. Both ports require that header plus an `Origin` check on mutations:

```
POST /testimonials  (no datastar-request header)   -> 403
POST /testimonials  (Origin: https://evil.com)     -> 403
```

**The trap:** a GET *is* a simple request, and Datastar puts every signal in the query
string. So the rule is absolute — **no GET may ever mutate.** In this app `GET /testimonials`
only re-renders.

With `SameSite=Lax` on the session cookie as the baseline, that is a defensible posture
without a token scheme. Add double-submit tokens if you need to support browsers where you
cannot rely on SameSite.

## What we built, and what it cost

| | SvelteKit + better-auth | Datastar + Go | Datastar + TS |
|---|---|---|---|
| Auth code | 511 (`lib/server/auth.ts`) + 13 | 212 (`auth.go`) | 102 (`auth.ts`) |
| Dependencies | `better-auth`, `@better-auth/stripe` | **0** — `crypto/pbkdf2` is stdlib (Go 1.24) | **0** — `Bun.password` is built in |
| Hashing | scrypt (better-auth default) | PBKDF2-SHA256, 210k iterations | argon2id |
| Sessions | better-auth tables | SHA-256 of the token in SQLite | SHA-256 of the token in SQLite |

Both ports: HttpOnly + SameSite=Lax + `Secure` under TLS, session tokens stored **hashed**
so a database dump grants nobody a login, and constant-time comparison plus a dummy hash on
unknown emails so response timing does not enumerate accounts.

11 browser-driven assertions cover it (`verify-auth.mjs`), including the stale-session SSE
redirect. Both backends pass all 11.

**But be honest about the comparison.** 212 lines buys email + password + sessions. Your
511 lines of better-auth config buys OAuth, organisations, invitations, email verification,
password reset, and Stripe subscriptions scoped to an org. Hand-rolling is cheap for the
basics and gets expensive fast after that.

## Recommendation per stack

**TypeScript — keep better-auth.** This is the finding that matters most: better-auth is
**framework-agnostic**. It exposes `auth.handler(request)` taking a Web-standard `Request`
and returning a `Response`, and it runs on Cloudflare Workers (with `nodejs_compat`), Bun
and Node. So the Datastar port can mount it directly:

```ts
if (url.pathname.startsWith("/api/auth/")) return auth.handler(req);
```

You would keep your existing org scoping and Stripe plugin and drop Datastar in front of
it. That makes "Datastar + TypeScript" a far smaller migration than it first looks — you
are replacing the view layer, not the auth layer.

**Go — hand-roll it, as here.** There is no better-auth equivalent with that plugin
surface. The stdlib now covers the hard parts (`crypto/pbkdf2` landed in Go 1.24), and
`auth.go` is 212 readable lines. If you need OAuth, add `markbates/goth`. If you need
orgs + billing, you are rebuilding a large part of better-auth by hand — which is a real
argument against Go for *this* product specifically.

**Do not reach for Lucia.** It was deprecated in March 2025 and is now a learning resource
plus a single-file reference implementation, not a maintained package. Plenty of
still-circulating advice recommends it.

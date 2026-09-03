# Walls + the public embed

The case I expected Datastar to lose. It half did — but not for the reason I assumed.

## The finding: SvelteKit was already not being used here

`embed/[id]/+server.ts` is a `+server.ts` returning a string, and `widget.ts` is a pure
string renderer. Grepping both for Svelte constructs (`$state`, `{#if}`, `{#each}`, any
`.svelte` import) finds **one hit in total** — the `error` helper from `@sveltejs/kit`.

So the most public, most security-critical, most cacheable part of the product had already
opted out of the framework. Porting it was transliteration, not migration. The framework
question simply does not arise on this route — which is itself the answer to "how would
Datastar handle the embed?"

## Datastar must not go near this page — and doesn't need to

Two reasons, both from Datastar's own [security docs](https://data-star.dev/reference/security):

1. **The default bundle needs `script-src 'unsafe-eval'`** — it compiles expressions with
   `Function()`. This document runs under `default-src 'none'` with a per-request nonce.
2. **CSP/nonce mode does not fix the real problem.** The docs are explicit: *"CSP mode does
   not make Datastar expressions safe to use with untrusted content."* This page renders
   text written by strangers.

The cost of leaving it out is zero: the widget has no interactivity to give up. Its only
script is nine lines that `postMessage` the document height to the parent frame.

**The general rule this suggests:** Datastar is opt-in per page. Use it on the authenticated
dashboard; leave the public, cacheable, untrusted-content surfaces as plain rendered HTML.
You do not have to pick one model for the whole app.

## A real flaw found in the original

`embed/[id]/+server.ts` sets `Cache-Control: public, max-age=60`.

But `frame-ancestors` — the control that decides which sites may embed a wall — is delivered
**in that response's headers**. A browser holding a cached copy keeps enforcing the policy
that was current when it was stored. Demonstrated in a real browser:

| | frame-ancestors served | customer site can frame it |
|---|---|---|
| unrestricted | `*` | yes (5 cards) |
| after restricting to `shop.example.com` | `https://shop.example.com` | **still yes, from cache** |
| same wall, cache-busted URL | `https://shop.example.com` | no |

So tightening a wall's allow-list does not take effect for up to a minute, and **nothing can
invalidate a copy already stored** — longer through any shared or CDN cache.

Both ports send `Cache-Control: no-cache` (revalidate every time) instead. The document is
small and carries a per-request nonce, so there was never much to cache. The browser test
asserts the restriction now bites immediately on the *same* URL.

Worth fixing in `social-proof` regardless of framework.

## What it cost

| | SvelteKit | Datastar + Go | Datastar + TS |
|---|---|---|---|
| Walls dashboard | 323 + 197 | 52 html + part of walls.go | 52 html + 76 store |
| Embed + API routes | 60 + 164 | embed.go | embed.ts |
| Trust logic + renderer | 243 + 267 | walls.go | walls.ts |
| **Total** | **1254** | **702** | **442** |

**132 of the TypeScript lines are byte-identical to your `walls.ts`** — `isSafeCssValue`,
`parseCssVars`, `parseAllowedDomains`, `isOriginAllowed`, `parseDomainInput` and
`generateWallId` are pure, so they moved across with a `diff` of zero. That is the third
time in this lab that pure logic has ported for free.

## Parity

Everything the original does: unguessable `wl_` ids, per-request nonce, `default-src 'none'`,
`frame-ancestors` from the allow-list, wildcard subdomains matching their apex, domain input
parsed from pasted URLs into bare hosts, CORS on the JSON API, `rel="noopener noreferrer
nofollow ugc"` on outbound links, disabled walls 404ing identically to missing ones, an empty
wall rendering an empty container rather than an error, and `approved` +
`verify_state != 'gone'` filtering.

`verify-embed.mjs` covers it with **17 browser-driven assertions**, including a hostile
testimonial (`<img src=x onerror=…><script>alert(2)</script>` as content, `</blockquote><b>XSS`
as the author name) rendered cross-origin in a real iframe and confirmed inert. Both backends
pass all 17.

## Where SvelteKit still wins

Not on this route — but on the *other* public routes. `social-proof` has `<Seo>`,
`PUBLIC_ROUTES` in `src/lib/seo.ts` that **fails the build** if a new public route is
unclassified, `OG_CARDS` + `pnpm og:image`, sitemap and `llms.txt` generation. None of that
has an equivalent here; you would be hand-rolling `<title>`/OG tags per page with nothing
checking you did it. For a marketing site that matters a great deal. For the embed — which
sets `<meta name="robots" content="noindex">` and is meant never to be found — it matters
not at all.

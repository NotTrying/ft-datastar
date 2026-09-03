# Datastar Lab

A working Datastar **v1.0.3** app, built twice — once in Go, once in TypeScript — behind
**one identical HTML file**. The point is to feel how fast you get from A to B, and to see
how much the backend language actually matters (spoiler: less than you'd think).

> Not to be confused with `/src` in this repo, which is `ft-datastar` — a **v1.0.0-beta.8**
> FastHTML integration using the retired `ds_on(...)` / `update_fragments` API. Two API
> breaks behind. This lab is independent of it.

## Run it

```bash
# Go — no dependencies to install
cd go && go run .                       # http://localhost:8080

# TypeScript — no dependencies to install
cd ts && bun server.ts                  # http://localhost:8081
```

Both serve the same `shared/index.html`, re-read on every request — **edit the HTML, hit
refresh.** No dev server, no HMR, no build step.

## What it demonstrates

| | What it shows |
|---|---|
| 1 · Client-only signals | Reactivity with zero server involvement, zero JS written |
| 2 · Live search | `data-on:input__debounce.300ms` → server → SSE patch of the list |
| 3 · Add / approve / delete | Round-trips that patch the DOM *and* reset form signals |
| 4 · Streaming job | **One** HTTP request pushing 9 progressive DOM patches |

Row 4 is the one that's genuinely awkward elsewhere. In SvelteKit it wants a WebSocket or
a polling endpoint plus a store plus a component subscription. Here it's a `for` loop that
writes to the response.

## Measured on this machine

| | Go 1.24.7 | TypeScript (Bun 1.3.11) |
|---|---|---|
| Dependencies | 0 | 0 |
| Build, cold cache | 11.8 s | — none — |
| Build, incremental | 136 ms | — none — |
| Startup → first byte | 15 ms | 28 ms |
| Resident memory | 7.5 MB | 42.3 MB |
| Server source | 256 lines | 152 lines |
| Artifact | 8.4 MB static binary | source file |

Shared frontend: **89 lines of HTML**. Datastar itself: 33.5 KB raw / **13.1 KB gzipped**,
vendored into `shared/datastar.js` and served from `/datastar.js`.

For scale, the SvelteKit app in the sibling repo: 171 tracked files, 89 source files,
38 direct dependencies, 12 config files at the root.

## Two things that will bite you

1. **npm is a decoy.** `@starfederation/datastar` on npm is stale at `1.0.0-beta.11`.
   Real releases ship as GitHub tags via jsDelivr. Vendor the file (as here) or pin the CDN tag.
2. **Multi-line HTML in SSE.** Every line of an `elements` payload needs its own
   `data: elements ` prefix. One line without it and the patch silently does nothing.
   Both `patchElements` helpers here handle it.

## Verifying

`verify.mjs` (Playwright) drives a real browser through all four sections against either
port. Both backends pass all six assertions with no console errors.

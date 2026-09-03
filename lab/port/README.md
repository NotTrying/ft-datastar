# social-proof dashboard, three ways

The **same feature** — the testimonials inbox from `social-proof` — implemented three
times, so the comparison is like-for-like instead of vibes.

| | Stack |
|---|---|
| **1. SvelteKit** | `social-proof` as it stands: SvelteKit + Cloudflare Workers + D1 + Drizzle + Tailwind/daisyUI |
| **2. Datastar + Go** | `go/` — stdlib routing, SQLite, SSE |
| **3. Datastar + TypeScript** | `ts/` — Web-standard fetch handler, `bun:sqlite`, SSE |

Both ports share the HTML in `shared/`. Three browser-driven suites cover them —
`verify-port.mjs` (dashboard), `verify-auth.mjs` (sessions, see [AUTH.md](AUTH.md)) and
`verify-scan.mjs` (handles + streaming scan, see [README-SCAN.md](README-SCAN.md)) —
**39 assertions in total, all passing on both backends.**

`verify-port.mjs` drives a real browser through 13 assertions: seeded counts,
tab switching, validation failures, form-state retention, successful add, duplicate
rejection, approve, and remove. **Both pass all 12 with no console errors.**

## Run

```bash
cd go && go run .      # http://localhost:8080
cd ts && bun server.ts # http://localhost:8083
```

## Feature parity

Everything the original dashboard does, minus auth (out of scope — every request is
`demo-user`, and the ownership checks are written as if it were real):

- stats row, tab filter, testimonial cards with per-status actions
- add-by-hand with the **full original validation**, including the required source URL,
  the `javascript:`/`data:` refusal, the future-date check, and URL normalisation
- duplicate rejection via the unique index on `(user_id, platform, post_id)`
- approve / dismiss / remove
- both empty states
- sessions, login, logout and CSRF defences ([AUTH.md](AUTH.md))
- monitored handles, plan limits, and a **streaming** scan ([README-SCAN.md](README-SCAN.md))

## The numbers

### Code for this feature

| | SvelteKit | Datastar + Go | Datastar + TS |
|---|---|---|---|
| Page / markup | 437 (`+page.svelte`) | 86 html + 85 css | 86 html + 85 css |
| Server logic | 171 + 57 | 211 + 115 + 41 | 144 + 63 |
| Validation | 182 | 147 | 182 *(copied verbatim)* |
| Data layer | *(Drizzle + D1)* | 158 | 92 |
| **Total** | **847** | **843** | **652** |

**Line count is roughly a wash — that is the honest headline.** But it is not
like-for-like: the Datastar totals *include* a hand-written data layer and hand-written
CSS, both of which SvelteKit gets from dependencies. Excluding those, the same feature is
**600 lines (Go)** or **475 lines (TS)** against **847**.

### Everything that isn't code

| | SvelteKit | Datastar + Go | Datastar + TS |
|---|---|---|---|
| Direct dependencies | 38 | 1 | **0** |
| Resolved packages | 489 | 25 | **0** |
| Root config files | 12 | 1 (`go.mod`) | 1 (`package.json`) |
| Build step | vite + svelte + lint + check + test | `go build`, 152 ms | **none** |
| Install before first run | `pnpm install` | `go mod download` | **none** |
| First-load weight | *(not measured — needs an install to build)* | 16.5 KB gzipped, 3 requests | same |
| Resident memory | — | 13.2 MB | 56.3 MB |
| Deploy artifact | Worker bundle | 14.4 MB static binary | source |

A tab switch — a full stats + tabs + list repaint — costs **1,893 bytes of SSE**.

## What porting actually taught us

**1. Pure business logic ports for free.** `manual-testimonial.ts` has zero imports, so it
moved into `ts/validate.ts` **byte-identical** (`diff` is empty). Into Go it became 147
lines. Nothing about the validation cared which framework called it. All the churn in a
port like this is *glue*, which is a good argument for keeping logic import-free wherever
you are.

**2. The client shrinks to nothing.** The SvelteKit page carries `$state`, `$derived`,
`$effect`, `onMount`, `invalidateAll()`, `use:enhance`, two `fetch` wrappers and an
`actionLoading` guard. The Datastar page has **no JavaScript at all** — the server owns
every piece of domain state and ships HTML. `renderList` serves both the first paint and
every later patch; there is no second client-side rendering path to keep in sync.

**3. A real bug the port surfaced.** HTML lowercases attribute names, so
`data-bind:authorName` creates the signal `$authorname` — not `$authorName`. Datastar's
documented rule is kebab-case in the key: **`data-bind:author-name` → `$authorName`**.
Worse, Go *hid* this: `encoding/json` matches keys case-insensitively, so the Go port
passed while the identical TypeScript port correctly failed. Both are fixed. Watch for it
on every multi-word signal.

## What you give up

Real costs, not hedging:

- **No client-side routing.** Every interaction is a round-trip, so latency is now UX.
- **No component model.** Server-rendered strings; composition is your own problem, and
  `render.go` / `render.ts` will get unwieldy before a component tree would.
- **No Tailwind/daisyUI.** 85 lines of hand CSS replace utility classes. Adding a build
  step back for Tailwind would undo much of the point.
- **No end-to-end type safety.** Signal names are strings in HTML, checked by nothing.
  Point 3 above is exactly the class of bug that creates — `pnpm check` would have caught
  the equivalent in Svelte.
- **`data-persist` and `data-query-string` are Pro**, not free-tier.

## Verdict

For this dashboard, Datastar is a clear win — not because it is less code, but because it
is **489 packages and a build pipeline lighter** for the same behaviour. The tradeoff is
that you hand-roll the two things dependencies were doing for you: the data layer and the
CSS.

# Handles + streaming scan

The one place Datastar buys a **capability**, not just less tooling.

## What changed

The SvelteKit original (`handles/+page.svelte`) scans like this:

```ts
scanning = handleId;
const response = await fetch("/api/scan", { method: "POST", body: JSON.stringify({ handleId }) });
scanResult = await response.json();   // {found, new, skipped}
scanning = null;
```

One blocking request. A spinner. Then a summary. **The user sees nothing for the duration**
and has no idea whether the scan is stuck, rate-limited, or nearly done.

The Datastar version streams the same work from a single `POST /scan`: a status line that
keeps updating, one row appended per mention *as it is decided*, a progress bar, then the
summary. Verified in a real browser — the feed fills `0→1→2→3→4→5`, not in one shot.

The mechanism is a `for` loop that writes to the response:

```go
for i, m := range mentions {
    // ...decide: already stored / over plan cap / insert...
    s.patchWith("selector #scan-feed\ndata: mode append", scanRow(m, verdict, cls))
    s.patch(progressBar(i+1, len(mentions)))
}
```

**Client-side JavaScript written to support this: none.** In the SvelteKit version it is
`scanHandle()`, three `$state` variables, and the spinner/result markup that reads them.

To be fair: SvelteKit *can* stream — a `+server.ts` returning a `ReadableStream` consumed by
`EventSource`. The difference is that you then write the client half yourself: subscribe,
parse, update a store, drive the re-render. Datastar's client half already exists.

## What it cost

| | SvelteKit | Datastar + Go | Datastar + TS |
|---|---|---|---|
| Handles page | 246 | 52 html | 52 html |
| Handles server | 156 | 244 | 55 + 113 store |
| Scan endpoint | 142 | 164 | 43 |
| Mock X source | 100 | *(in scan.go)* | *(in scan.ts)* |
| **Total** | **644** | **460** | **263** |

Unlike the dashboard port — where line count was a wash — this feature really is smaller,
because the entire client-side scan-progress apparatus disappears.

## Parity

Everything the original does: handle validation (ported verbatim — `@` stripped, 1–50 chars,
`^[a-zA-Z0-9_]+$`), duplicate rejection, plan limits (`maxHandles`, `scansPerMonth`,
`maxTestimonials` from `pricing.ts`, `-1` = unlimited), `sinceId` narrowing on rescan,
dedupe against stored `post_id`s, insert-up-to-the-cap-and-report-the-rest, and
`lastScannedAt`/`lastPostId` updates.

`verify-scan.mjs` covers it with **15 browser-driven assertions**, including that rows
arrive progressively. Both backends pass all 15.

## Two findings

**1. The server can patch a `_`-prefixed signal.** This was genuinely unclear from the docs.
The `_` prefix stops a signal being *sent to* the server — it does **not** stop the server
*setting* it. So `s.signals("{_scanning: true}")` correctly disables every scan button
mid-scan, and the flag never bloats any request payload. That is the right way to drive
transient UI state during a stream.

**2. A bug in the original.** `api/scan/+server.ts` checks the monthly scan allowance like
this:

```ts
const scanCount = await db.select({count}).from(testimonial)
  .where(and(eq(testimonial.userId, userId), sql`${testimonial.createdAt} >= ${startOfMonth}`));
if (!canUseLimit(limits.scansPerMonth, scanCount?.count ?? 0))
  throw error(403, "Monthly scan limit reached.");
```

It counts **testimonials created this month**, not scans. So:

- a scan that finds nothing costs nothing against the allowance, and
- **manually added testimonials burn the scan allowance** — add 30 by hand on the free plan
  and scanning stops working, with a message blaming scans.

This port logs scans to a `scan_log` table and counts those instead. Worth fixing in
`social-proof` regardless of which framework you land on.

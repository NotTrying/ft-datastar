// Liveness: confirming that each approved testimonial still resolves to a live
// original. Ported from src/lib/server/liveness.ts.
//
// This is the claim the product rests on, so the code is deliberately biased
// toward NOT acting. Wrongly marking a real testimonial `gone` silently removes
// a paying customer's testimonial from their own website — so a quote is only
// ever retired on an unambiguous negative signal. Anything else (a timeout, a
// rate limit, a 5xx, a network error) leaves both the state and the timestamp
// untouched, so the row is retried later rather than being recorded as
// "verified" on the strength of a failed request.
//
// Triggered by wall renders, as in the original: each render verifies a few of
// that wall's oldest-checked quotes, without blocking the response. Walls
// nobody looks at go unverified, which is the right priority — a stale quote
// only matters where it is being displayed.
import type { Store } from "./store.ts";

export type VerifyOutcome = "live" | "gone" | "unknown";

/** How long a confirmation stays good for. */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-request budget. A hung platform must not hold a worker open. */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * X's public oEmbed endpoint. Purpose-built, needs no key, and gives a clean
 * 404 for a deleted status — whereas x.com returns its app shell (200) for a
 * range of missing things.
 *
 * KNOWN LIMIT carried over from the original: oEmbed returns 404 for a deleted
 * status but 200 for a status id under an account that does not exist. So this
 * detects deleted posts reliably and suspended or deleted ACCOUNTS not at all.
 * Do not describe it to customers as more than it is.
 */
const X_OEMBED = "https://publish.x.com/oembed?omit_script=1&url=";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let livenessFetch: Fetcher = (url, init) => fetch(url, init);
export const setLivenessFetch = (f: Fetcher) => { livenessFetch = f; };

/**
 * Does this post still resolve publicly?
 *
 * Returns 'unknown' for every platform we have no reliable check for, which
 * means those never get retired. That is intentional: no signal is not a
 * negative signal.
 */
export async function checkPostLiveness(platform: string, postUrl: string): Promise<VerifyOutcome> {
  if (platform !== "x") return "unknown";

  let response: Response;
  try {
    response = await livenessFetch(`${X_OEMBED}${encodeURIComponent(postUrl)}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Timeout, DNS failure, connection reset — tells us nothing about the post.
    return "unknown";
  }

  if (response.status === 404 || response.status === 410) return "gone";
  if (response.ok) return "live";
  // 429 and 5xx say something about the platform, not the testimonial.
  return "unknown";
}

export type SweepResult = { checked: number; live: number; gone: number; unknown: number };

/**
 * Re-check the least-recently-verified approved testimonials.
 *
 * Never selects rows already marked `gone`: a retired quote stays retired
 * rather than flapping back onto a customer's site if a platform has a bad
 * minute. Un-retiring one is a deliberate act, not something a sweep does.
 */
export async function sweepLiveness(
  store: Store,
  opts: { orgId?: string; limit?: number; now?: number; staleAfterMs?: number } = {},
): Promise<SweepResult> {
  const { orgId, limit = 3, now = Date.now(), staleAfterMs = STALE_AFTER_MS } = opts;
  const due = store.dueForVerification(orgId ?? null, limit, now - staleAfterMs);
  const result: SweepResult = { checked: 0, live: 0, gone: 0, unknown: 0 };

  for (const row of due) {
    const outcome = await checkPostLiveness(row.platform, row.post_url);
    result.checked++;
    result[outcome]++;
    // An inconclusive check writes nothing at all — not even the timestamp.
    // Recording a verification we did not make would let a row age out of the
    // queue while its original may already be gone.
    if (outcome === "unknown") continue;
    store.setVerifyState(row.id, outcome, now);
  }
  return result;
}

/** Dev-only stub upstream, installed when LAB_DEV=1. Never touches the network. */
export function installStubLiveness() {
  setLivenessFetch(async (url) => {
    const target = decodeURIComponent(url.slice(X_OEMBED.length));
    if (target.includes("/deleted/")) return new Response("gone", { status: 404 });
    if (target.includes("/ratelimited/")) return new Response("slow down", { status: 429 });
    if (target.includes("/broken/")) throw new Error("connection reset");
    return new Response(JSON.stringify({ html: "<blockquote/>" }), { status: 200 });
  });
}

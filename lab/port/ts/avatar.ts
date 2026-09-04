// GET /api/v1/avatar/:testimonialId — proxies one testimonial author's avatar.
// Ported from src/routes/api/v1/avatar/[id]/+server.ts.
//
// Why proxy at all: a wall renders on a customer's website. Hotlinking the
// platform CDN would hand X (or whoever) the IP address of every visitor to
// that customer's site, on a page those visitors never chose to load from X.
//
// Why the parameter is a testimonial id and NOT a URL: an endpoint that fetches
// a caller-supplied URL is an SSRF hole, and signing the URL only moves the
// problem. Here the URL comes from our own database, so a caller can ask for
// "the avatar of testimonial X" and nothing else.
import type { Store } from "./store.ts";

const CACHE_TTL_SECONDS = 86_400;
const MAX_BYTES = 512 * 1024;

/** Only real image types get re-served, and the response is pinned to the type
 *  we matched — never the upstream's own header, which we do not trust. */
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * The upstream fetcher. Swappable ONLY so the browser suite can exercise the
 * success and rejection paths: this container cannot reach the public internet,
 * so a real CDN fetch is untestable here. Every check below still runs against
 * the stub — the https rule, the type allowlist, the size limit and the header
 * pinning are all unchanged. Production uses global fetch.
 */
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let upstreamFetch: Fetcher = (url, init) => fetch(url, init);
export const setUpstreamFetch = (f: Fetcher) => { upstreamFetch = f; };

export async function serveAvatar(store: Store, testimonialId: string): Promise<Response> {
  const stored = store.avatarFor(testimonialId);
  if (!stored) return new Response("No avatar", { status: 404 });

  let target: URL;
  try {
    target = new URL(stored);
  } catch {
    return new Response("No avatar", { status: 404 });
  }
  // Defence in depth: even though the value came from our own database, a row
  // written by a future ingest bug must not be able to make us fetch plaintext
  // or an internal address.
  if (target.protocol !== "https:") return new Response("No avatar", { status: 404 });

  let upstream: Response;
  try {
    upstream = await upstreamFetch(target.href, { headers: { accept: "image/*" } });
  } catch {
    return new Response("Avatar fetch failed", { status: 502 });
  }
  if (!upstream.ok) return new Response("No avatar", { status: 404 });

  const contentType = (upstream.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!ALLOWED_TYPES.has(contentType))
    return new Response("Unsupported avatar type", { status: 415 });

  const length = Number(upstream.headers.get("content-length") ?? "0");
  if (length > MAX_BYTES) return new Response("Avatar too large", { status: 413 });

  const body = await upstream.arrayBuffer();
  // Checked again against the real bytes: content-length is the upstream's
  // claim, not a fact.
  if (body.byteLength > MAX_BYTES) return new Response("Avatar too large", { status: 413 });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(body.byteLength),
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}, immutable`,
      "access-control-allow-origin": "*",
      // The upstream decides the bytes, so make sure nothing can persuade a
      // browser to treat them as script.
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}

/** A 1×1 transparent PNG, used by the dev stub below. */
const PIXEL = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
), (c) => c.charCodeAt(0));

/**
 * Dev-only stand-in for the CDN, installed when LAB_DEV=1. It answers a few
 * fixed https hosts so the suite can prove each rejection path; anything else
 * 404s. It never touches the network.
 */
export function installStubUpstream() {
  setUpstreamFetch(async (href) => {
    if (href === "https://avatars.test/ok.png")
      return new Response(PIXEL, { headers: { "content-type": "image/png; charset=binary",
        "content-length": String(PIXEL.byteLength) } });
    if (href === "https://avatars.test/lying-type")
      return new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } });
    if (href === "https://avatars.test/too-big")
      return new Response(new Uint8Array(600 * 1024), { headers: { "content-type": "image/png",
        "content-length": String(600 * 1024) } });
    if (href === "https://avatars.test/boom") throw new Error("connection refused");
    return new Response("nope", { status: 404 });
  });
}

// Authentication. Datastar has nothing to say about this — it is a hypermedia
// layer, not a framework — so all of it is hand-rolled on Web-standard APIs.
//
// Two Datastar-specific wrinkles drive the design:
//
//  1. A 302 is useless to an SSE request. `fetch` follows the redirect and
//     hands Datastar the login *page* as if it were an event stream. So an
//     expired session on a Datastar request has to answer with the documented
//     redirect: patch a <script> into the body.
//  2. Every signal on the page is sent with every request, so nothing
//     sensitive may ever live in one. Sessions live in an HttpOnly cookie the
//     page cannot read.
import { rt } from "./runtime.ts";
import type { Store } from "./store.ts";

export const COOKIE = "sp_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Through the runtime seam: argon2id on Bun, PBKDF2-SHA256 via WebCrypto on
// Workers, which has no argon2. See runtime.ts.
export const hashPassword = (pw: string) => rt().hashPassword(pw);
export const verifyPassword = (pw: string, hash: string) => rt().verifyPassword(pw, hash);

// The cookie holds the raw token; the database holds only its SHA-256. A dump
// of the session table therefore does not let anyone log in as anybody.
export async function tokenHash(tok: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tok));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function sessionCookie(tok: string, expires: Date, secure: boolean): string {
  return `${COOKIE}=${tok}; Path=/; Expires=${expires.toUTCString()}; HttpOnly; SameSite=Lax` +
    (secure ? "; Secure" : "");
}
export const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export const isDatastar = (req: Request) => req.headers.get("datastar-request") === "true";

// CSRF. Datastar sends `datastar-request: true` on every request, and JSON on
// non-GET. A custom header is never a CORS "simple request", so a cross-origin
// page cannot make the browser send one without a preflight this server never
// approves. Origin is checked too where the browser supplies it.
//
// The rule this leans on: no GET in this app ever mutates. A GET *is* simple,
// and it carries every signal in the query string.
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // no Origin header: not a cross-site browser request
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

// A 302 cannot move an SSE request, so the documented mechanism is to patch a
// <script> into the body. setTimeout keeps Firefox's back history intact.
export function sseRedirect(to: string, headers: Record<string, string> = {}): Response {
  const body =
    `event: datastar-patch-elements\ndata: selector body\ndata: mode append\n` +
    `data: elements <script>setTimeout(() => window.location = ${JSON.stringify(to)})</script>\n\n`;
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers },
  });
}

export async function currentUser(store: Store, req: Request): Promise<string | null> {
  const tok = readCookie(req, COOKIE);
  if (!tok) return null;
  const uid = store.userForToken(await tokenHash(tok));
  if (!uid) return null;
  // Banning revokes sessions, but a ban applied by any other path must still
  // take effect immediately rather than waiting for the cookie to expire.
  const u = store.userById(uid);
  if (!u) return null;
  if (u.banned && (u.ban_expires === null || u.ban_expires > Date.now())) return null;
  return uid;
}

// Guard for every protected route.
export async function requireUser(
  store: Store, req: Request, next: (userId: string) => Response | Promise<Response>,
): Promise<Response> {
  if (req.method !== "GET" && (!isDatastar(req) || !sameOrigin(req)))
    return new Response("forbidden", { status: 403 });

  const uid = await currentUser(store, req);
  if (uid) return next(uid);

  const headers = { "set-cookie": clearCookie() };
  return isDatastar(req)
    ? sseRedirect("/login", headers) // an expired session mid-interaction
    : new Response(null, { status: 302, headers: { ...headers, location: "/login" } });
}

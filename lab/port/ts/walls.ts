// Walls: the public read path.
//
// Lines 23–154 below are copied VERBATIM from
// social-proof/src/lib/server/walls.ts — the trust checks there are pure
// (no drizzle, no fetch), so they moved across untouched. Only the
// ALLOWED_CSS_VARS import became a local constant.
//
// Everything here runs for anonymous visitors on somebody else's website, so
// the rules are stricter than the dashboard's: validate on the way OUT as well
// as in, because a row written months ago under looser code still renders on a
// customer's site today.

const ALLOWED_CSS_VARS = [
  "--sp-bg", "--sp-card", "--sp-ink", "--sp-muted",
  "--sp-border", "--sp-accent", "--sp-radius", "--sp-font",
] as const;

export const WALL_LAYOUTS = ["grid", "column", "carousel"];
export const WALL_THEMES = ["light", "dark", "auto"];
export const WALL_DENSITIES = ["comfortable", "compact"];

const CSS_VALUE_RE = /^[a-zA-Z0-9#%.,()\-_ /]{1,64}$/;
const CSS_VALUE_DENY_RE = /url\(|expression\(|@import|\/\*/i;

export function isSafeCssValue(value: unknown): value is string {
	return typeof value === 'string' && CSS_VALUE_RE.test(value) && !CSS_VALUE_DENY_RE.test(value);
}

/** Parse and filter the stored `css_vars` JSON. Never throws — a corrupt or
 *  hostile value yields an empty object rather than breaking the wall. */
export function parseCssVars(raw: string | null): Record<string, string> {
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
	const out: Record<string, string> = {};
	for (const key of ALLOWED_CSS_VARS) {
		const value = (parsed as Record<string, unknown>)[key];
		if (isSafeCssValue(value)) out[key] = value;
	}
	return out;
}

/** Parse the stored `allowed_domains` JSON. `null` means "not yet restricted",
 *  which is distinct from `[]` — an empty array allows nothing. */
export function parseAllowedDomains(raw: string | null): string[] | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const list = parsed.filter((d): d is string => typeof d === 'string' && d.length > 0);
	return list;
}

/** Strip a leading `www.` and lowercase. `www.example.com` and `example.com`
 *  are the same site to a customer, and the app already 301s one to the other. */
function normalizeHost(host: string): string {
	return host.replace(/^www\./i, '').toLowerCase();
}

/**
 * Is `origin` allowed to render this wall?
 *
 * Entries are bare hostnames (`example.com`), optionally wildcarded one level
 * up (`*.example.com`, which also matches the apex). A `null` list is an
 * unrestricted wall — the state every wall starts in, so a customer's embed
 * works the moment they paste it and tightening it is a later, deliberate step.
 *
 * NOTE: this is a browser-level control, enforced through CORS and
 * frame-ancestors. It stops a wall id being lifted onto another site or reused
 * as free hosting; it is not a secrecy boundary, and it cannot be — the payload
 * is testimonials the owner is publishing on their own public website.
 */
export function isOriginAllowed(origin: string | null, allowed: string[] | null): boolean {
	if (allowed === null) return true;
	if (allowed.length === 0) return false;
	if (!origin) return false;
	let host: string;
	try {
		host = normalizeHost(new URL(origin).hostname);
	} catch {
		return false;
	}
	return allowed.some((entry) => {
		const trimmed = entry.trim();
		if (trimmed.startsWith('*.')) {
			const base = normalizeHost(trimmed.slice(2));
			return host === base || host.endsWith(`.${base}`);
		}
		return host === normalizeHost(trimmed);
	});
}

/**
 * Generate a public wall id.
 *
 * This value ends up pasted into a customer's HTML, so it is not a secret —
 * but it should not be guessable either, or one customer could stumble onto
 * another's wall. 20 base-32 characters from crypto random is ~100 bits.
 */
export function generateWallId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(13));
	let out = '';
	for (const b of bytes) out += b.toString(32).padStart(2, '0');
	return `wl_${out.slice(0, 20)}`;
}

/**
 * Parse the allowed-domains textarea into storable hostnames.
 *
 * Accepts what a person actually types — a full URL, a bare host, with or
 * without `www.`, separated by commas or newlines — and stores the bare
 * hostname. Returns `null` for empty input, which means "unrestricted"; that
 * distinction is load-bearing (see isOriginAllowed).
 */
export function parseDomainInput(raw: string): string[] | null {
	const parts = raw
		.split(/[\s,]+/)
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length === 0) return null;

	const out: string[] = [];
	for (const part of parts) {
		let host = part;
		// Tolerate a pasted URL.
		if (host.includes('://')) {
			try {
				host = new URL(host).hostname;
			} catch {
				continue;
			}
		}
		// Strip a path, port, or stray leading dot.
		host = host.split('/')[0].split(':')[0].replace(/^\.+/, '').toLowerCase();
		const wildcard = host.startsWith('*.');
		const bare = wildcard ? host.slice(2) : host;
		// A hostname, not free text: labels of letters/digits/hyphens, at least
		// one dot. Anything else is a typo and is dropped rather than stored.
		if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(bare)) continue;
		const entry = wildcard ? `*.${bare}` : bare;
		if (!out.includes(entry)) out.push(entry);
	}
	return out.length ? out : null;
}

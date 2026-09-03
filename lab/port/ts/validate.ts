/**
 * Manual testimonials — turning something a customer was told into a row.
 *
 * Scanning only ever finds quotes on platforms we can search. Most of the proof
 * a small business already has does not live there: it is a Google review, a
 * Facebook recommendation, a comment under a listing. This module is the other
 * way in.
 *
 * The one rule it will not bend on: **a manual testimonial still needs a public
 * source URL.** The product's whole claim is that every quote on a wall resolves
 * to a live original, which is precisely what a screenshot wall cannot say
 * (docs/WIDGET-ARCHITECTURE.md §4). Allowing a quote with no source would keep
 * the marketing and quietly discard the thing it describes. So the URL is
 * required, it is validated, and it is what the row is deduplicated on.
 *
 * Everything here is pure: no database, no fetch. The caller does the insert.
 * That keeps the rules testable without a D1 instance and stops validation
 * drifting into the route.
 */

/** Untrusted input, straight off the form. */
export interface ManualTestimonialInput {
	content?: string | null;
	authorName?: string | null;
	authorHandle?: string | null;
	sourceUrl?: string | null;
	postedAt?: string | null;
}

/** A validated row, ready to hand to drizzle. */
export interface ManualTestimonialRow {
	source: 'manual';
	platform: string;
	postId: string;
	postUrl: string;
	authorHandle: string | null;
	authorName: string | null;
	content: string;
	postedAt: Date | null;
}

export type ManualTestimonialResult =
	{ ok: true; row: ManualTestimonialRow } | { ok: false; field: string; error: string };

/** Long enough for a generous review, short enough not to be an essay or an attack. */
const MAX_CONTENT = 2000;
const MAX_NAME = 100;
const MAX_URL = 2048;

/**
 * Hosts we can name. Anything else is 'web', which is honest rather than wrong.
 *
 * `x` matters beyond labelling: liveness knows how to re-check an X post, so a
 * pasted tweet gets verified like a scanned one. Every other platform returns
 * 'unknown' from the checker and is therefore never retired — no signal is not
 * a negative signal (src/lib/server/liveness.ts).
 */
const HOSTS: [RegExp, string][] = [
	[/^(www\.|mobile\.)?(x|twitter)\.com$/, 'x'],
	[/(^|\.)facebook\.com$/, 'facebook'],
	[/(^|\.)instagram\.com$/, 'instagram'],
	[/(^|\.)linkedin\.com$/, 'linkedin'],
	[/(^|\.)(google\.[a-z.]+|g\.page|goo\.gl)$/, 'google'],
	[/(^|\.)productreview\.com\.au$/, 'productreview'],
	[/(^|\.)trustpilot\.com$/, 'trustpilot'],
	[/(^|\.)bsky\.app$/, 'bluesky'],
	[/(^|\.)news\.ycombinator\.com$/, 'hackernews']
];

function platformFor(host: string): string {
	const h = host.toLowerCase();
	for (const [rx, name] of HOSTS) {
		if (rx.test(h)) return name;
	}
	return 'web';
}

/**
 * A stable identity for the source, used as `post_id`.
 *
 * The unique index on (user_id, platform, post_id) then rejects the same review
 * entered twice — in the database, not in a check the write path could forget.
 * Normalising first means a trailing slash or a tracking fragment does not
 * defeat it.
 */
function normaliseUrl(u: URL): string {
	u.hash = '';
	u.hostname = u.hostname.toLowerCase();
	if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
		u.pathname = u.pathname.slice(0, -1);
	}
	return u.toString();
}

export function validateManualTestimonial(input: ManualTestimonialInput): ManualTestimonialResult {
	const content = (input.content ?? '').trim();
	if (!content) {
		return { ok: false, field: 'content', error: 'Enter what the customer said.' };
	}
	if (content.length > MAX_CONTENT) {
		return {
			ok: false,
			field: 'content',
			error: `That is longer than ${MAX_CONTENT} characters. Trim it to the part worth showing.`
		};
	}

	const authorName = (input.authorName ?? '').trim() || null;
	const authorHandle = (input.authorHandle ?? '').trim().replace(/^@/, '') || null;
	if (!authorName && !authorHandle) {
		return {
			ok: false,
			field: 'authorName',
			error: 'Give a name or a handle — a quote with neither cannot be attributed.'
		};
	}
	if ((authorName?.length ?? 0) > MAX_NAME || (authorHandle?.length ?? 0) > MAX_NAME) {
		return {
			ok: false,
			field: 'authorName',
			error: 'Name and handle are limited to 100 characters.'
		};
	}

	const rawUrl = (input.sourceUrl ?? '').trim();
	if (!rawUrl) {
		return {
			ok: false,
			field: 'sourceUrl',
			error: 'A link to the original is required — it is what makes the wall verifiable.'
		};
	}
	if (rawUrl.length > MAX_URL) {
		return { ok: false, field: 'sourceUrl', error: 'That link is too long.' };
	}
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { ok: false, field: 'sourceUrl', error: 'That is not a valid link.' };
	}
	// Anything but http(s) — javascript:, data:, file: — is refused outright
	// rather than sanitised later, because this value ends up as an href on
	// someone else's website.
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		return {
			ok: false,
			field: 'sourceUrl',
			error: 'The link must start with http:// or https://.'
		};
	}

	let postedAt: Date | null = null;
	const rawDate = (input.postedAt ?? '').trim();
	if (rawDate) {
		const d = new Date(rawDate);
		if (Number.isNaN(d.getTime())) {
			return { ok: false, field: 'postedAt', error: 'That is not a valid date.' };
		}
		// A testimonial from the future is a typo, and it would sort above every
		// real one on the wall.
		if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
			return { ok: false, field: 'postedAt', error: 'That date is in the future.' };
		}
		postedAt = d;
	}

	const postUrl = normaliseUrl(url);
	return {
		ok: true,
		row: {
			source: 'manual',
			platform: platformFor(url.hostname),
			postId: postUrl,
			postUrl,
			authorHandle,
			authorName,
			content,
			postedAt
		}
	};
}

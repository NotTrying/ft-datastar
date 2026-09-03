// The scan flow. This is the one place Datastar buys a capability rather than
// just less tooling.
//
// The SvelteKit original is a blocking fetch: spinner, then a {found,new,skipped}
// summary. The user sees nothing for the duration. Here the same work streams —
// one HTTP request, a patch per mention as it is decided — with no WebSocket,
// no store, and no client-side subscription.
import { esc } from "./render.ts";

export type Mention = {
  platform: string; postId: string; postUrl: string;
  authorHandle: string; authorName: string; content: string; postedAt: Date;
};

// Mock X source, mirroring src/lib/server/sources/x.ts.
const MOCK: [string, string, string, string, number][] = [
  ["mock_1", "happycustomer", "Sarah Johnson", "Just started using @%s and wow, the dashboard is so clean. Finally a tool that actually saves me time!", 2],
  ["mock_2", "techreviewer", "Mike Chen", "Been testing @%s for a week. The mention scanning is exactly what I needed for tracking brand reputation. Highly recommend.", 8],
  ["mock_3", "startupfounder", "Alex Rivera", "Does anyone know if @%s supports competitor tracking? Would love to monitor what people say about our rivals too.", 24],
  ["mock_4", "unhappyuser", "Jordan Blake", "Tried @%s but the free tier is too limited. Only 1 handle? Come on, at least give us 3 for testing.", 48],
  ["mock_5", "marketingpro", "Emily Watson", "Using @%s to collect testimonials for our landing page. So much easier than manually screenshotting tweets. Game changer for social proof!", 72],
];

export function searchMentions(handle: string, sinceId: string | null): { mentions: Mention[]; newestId: string } {
  // Simulate sinceId filtering: a repeat scan finds fewer, as in the original.
  const rows = sinceId ? MOCK.slice(0, 2) : MOCK;
  const mentions = rows.map(([postId, author, name, text, agoHours]) => ({
    platform: "x", postId,
    postUrl: `https://x.com/${author}/status/${postId}`,
    authorHandle: author, authorName: name,
    content: text.replace("%s", handle),
    postedAt: new Date(Date.now() - agoHours * 60 * 60 * 1000),
  }));
  return { mentions, newestId: mentions[0]?.postId ?? "" };
}

const trim = (s: string, n: number) => ([...s].length <= n ? s : [...s].slice(0, n).join("") + "…");

export const scanRow = (m: Mention, verdict: string, cls: string) =>
  `<div class="scan-row ${cls}"><span class="av sm">${esc(m.authorName[0]!.toUpperCase())}</span>` +
  `<span class="grow"><b>${esc(m.authorName)}</b> <span class="muted">@${esc(m.authorHandle)}</span><br>` +
  `<span class="muted small">${esc(trim(m.content, 90))}</span></span>` +
  `<span class="verdict">${esc(verdict)}</span></div>`;

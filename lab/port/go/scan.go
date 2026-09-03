package main

// The scan flow. This is the one place Datastar buys a capability rather than
// just less tooling.
//
// The SvelteKit original is a blocking fetch: spinner, then a {found,new,skipped}
// summary. The user sees nothing for the duration. Here the same work streams —
// one HTTP request, a patch per mention as it is decided — with no WebSocket,
// no store, and no client-side subscription.

import (
	"fmt"
	"net/http"
	"strings"
	"time"
)

// ---------- mock X source (mirrors src/lib/server/sources/x.ts) ----------

type Mention struct {
	Platform, PostID, PostURL, AuthorHandle, AuthorName, Content string
	PostedAt                                                     time.Time
}

func searchMentions(handle, sinceID string) ([]Mention, string) {
	type tpl struct {
		id, author, name, text string
		agoHours               int
	}
	mock := []tpl{
		{"mock_1", "happycustomer", "Sarah Johnson", "Just started using @%s and wow, the dashboard is so clean. Finally a tool that actually saves me time!", 2},
		{"mock_2", "techreviewer", "Mike Chen", "Been testing @%s for a week. The mention scanning is exactly what I needed for tracking brand reputation. Highly recommend.", 8},
		{"mock_3", "startupfounder", "Alex Rivera", "Does anyone know if @%s supports competitor tracking? Would love to monitor what people say about our rivals too.", 24},
		{"mock_4", "unhappyuser", "Jordan Blake", "Tried @%s but the free tier is too limited. Only 1 handle? Come on, at least give us 3 for testing.", 48},
		{"mock_5", "marketingpro", "Emily Watson", "Using @%s to collect testimonials for our landing page. So much easier than manually screenshotting tweets. Game changer for social proof!", 72},
	}
	// Simulate sinceId filtering: a repeat scan finds fewer, as in the original.
	if sinceID != "" {
		mock = mock[:2]
	}
	var out []Mention
	for _, m := range mock {
		out = append(out, Mention{
			Platform: "x", PostID: m.id,
			PostURL:      fmt.Sprintf("https://x.com/%s/status/%s", m.author, m.id),
			AuthorHandle: m.author, AuthorName: m.name,
			Content:  fmt.Sprintf(m.text, handle),
			PostedAt: time.Now().Add(-time.Duration(m.agoHours) * time.Hour),
		})
	}
	newest := ""
	if len(out) > 0 {
		newest = out[0].PostID
	}
	return out, newest
}

// ---------- streaming handler ----------

func scanRow(m Mention, verdict, cls string) string {
	return fmt.Sprintf(
		`<div class="scan-row %s"><span class="av sm">%s</span>`+
			`<span class="grow"><b>%s</b> <span class="muted">@%s</span><br>`+
			`<span class="muted small">%s</span></span>`+
			`<span class="verdict">%s</span></div>`,
		cls, esc(strings.ToUpper(m.AuthorName[:1])), esc(m.AuthorName), esc(m.AuthorHandle),
		esc(trim(m.Content, 90)), esc(verdict))
}

func trim(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func handleScan(store *Store) authed {
	return func(w http.ResponseWriter, r *http.Request, uid string) {
		h, ok := store.HandleByID(uid, r.URL.Query().Get("id"))
		if !ok {
			http.Error(w, "handle not found", 404)
			return
		}
		lim := store.LimitsFor(uid)

		s, sok := newSSE(w)
		if !sok {
			return
		}
		// The whole panel is replaced first so a repeat scan starts clean.
		s.patch(`<div id="scan-panel"><div id="scan-status" class="muted small">Starting…</div>` +
			`<div id="scan-feed" class="scan-feed"></div><div id="scan-summary"></div></div>`)
		s.signals(`{_scanning: true}`)

		defer func() { s.signals(`{_scanning: false}`) }()

		if !canUse(lim.ScansPerMonth, store.ScansThisMonth(uid)) {
			s.patch(`<div id="scan-status" class="alert err">Monthly scan limit reached. ` +
				`Upgrade your plan for more scans.</div>`)
			return
		}
		store.LogScan(uid, h.ID)

		step := func(msg string) {
			s.patch(fmt.Sprintf(`<div id="scan-status" class="muted small">%s</div>`, esc(msg)))
		}

		step("Searching X for mentions of @" + h.Name + "…")
		select {
		case <-r.Context().Done():
			return
		case <-time.After(500 * time.Millisecond):
		}

		mentions, newest := searchMentions(h.Name, h.LastPostID)
		known := store.KnownPostIDs(uid, "x")
		stored := store.Count(uid)

		step(fmt.Sprintf("Found %d mentions. Checking them against what you already have…", len(mentions)))

		var added, skippedDupe, skippedCap int
		for i, m := range mentions {
			select {
			case <-r.Context().Done():
				return // the user navigated away; stop scanning
			case <-time.After(320 * time.Millisecond):
			}

			var verdict, cls string
			switch {
			case known[m.PostID]:
				verdict, cls, skippedDupe = "already stored", "dupe", skippedDupe+1
			case !canUse(lim.MaxTestimonials, stored):
				// Insert up to the remaining room and report the rest as
				// skipped, rather than failing the whole scan.
				verdict, cls, skippedCap = "over plan cap", "capped", skippedCap+1
			default:
				if err := store.InsertScanned(uid, h.ID, m); err != nil {
					verdict, cls, skippedDupe = "already stored", "dupe", skippedDupe+1
				} else {
					verdict, cls, added, stored = "added to Pending", "new", added+1, stored+1
				}
			}

			// mode append: each row joins the feed as it is decided.
			s.patchWith("selector #scan-feed\ndata: mode append", scanRow(m, verdict, cls))
			s.patch(fmt.Sprintf(
				`<div id="scan-status" class="muted small">Checked %d of %d…`+
					`<div class="bar"><i style="width:%d%%"></i></div></div>`,
				i+1, len(mentions), (i+1)*100/len(mentions)))
		}

		store.TouchHandle(h.ID, newest)

		summary := fmt.Sprintf("%d found &middot; %d new &middot; %d already stored", len(mentions), added, skippedDupe)
		if skippedCap > 0 {
			summary += fmt.Sprintf(" &middot; %d skipped (plan cap)", skippedCap)
		}
		s.patch(`<div id="scan-status" class="muted small">Done.</div>`)
		s.patch(fmt.Sprintf(`<div id="scan-summary"><div class="alert ok" role="status">%s</div></div>`, summary))
		s.patch(RenderHandles(store.ListHandles(uid), lim))
	}
}

package main

// The embed widget. Ported from src/lib/server/widget.ts and
// src/routes/embed/[id]/+server.ts.
//
// NOTE THE ABSENCE: there is no Datastar on this page, deliberately.
//
//  1. The default bundle evaluates expressions with Function(), so it needs
//     `script-src 'unsafe-eval'`. This document runs under `default-src 'none'`
//     with a per-request nonce, and it renders text written by strangers.
//  2. Datastar's own docs are explicit that even CSP/nonce mode "does not make
//     Datastar expressions safe to use with untrusted content."
//
// So the widget stays a pure string-rendered document. Which costs nothing —
// it has no interactivity to give up. The same was already true in SvelteKit:
// this route is a `+server.ts` returning a string, using zero Svelte.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

func frameAncestors(allowed []string) string {
	if allowed == nil {
		return "*"
	}
	if len(allowed) == 0 {
		return "'none'"
	}
	var out []string
	for _, e := range allowed {
		h := strings.ToLower(strings.TrimSpace(e))
		if strings.HasPrefix(h, "*.") {
			out = append(out, "https://*."+h[2:])
		} else {
			out = append(out, "https://"+h)
		}
	}
	return strings.Join(out, " ")
}

// Per-embed overrides forwarded by the loader, so one wall can appear twice on
// a site with two different looks. Validated against fixed allow-lists.
func applyOverrides(w *Wall, q map[string][]string) {
	pick := func(name string, allowed []string, cur string) string {
		if v := first(q[name]); v != "" && contains(allowed, v) {
			return v
		}
		return cur
	}
	w.Layout = pick("layout", layouts, w.Layout)
	w.Theme = pick("theme", themes, w.Theme)
	w.Density = pick("density", densities, w.Density)
	switch first(q["dates"]) {
	case "on":
		w.ShowDates = true
	case "off":
		w.ShowDates = false
	}
}

func first(xs []string) string {
	if len(xs) == 0 {
		return ""
	}
	return xs[0]
}

func initials(name, handle string) string {
	s := name
	if s == "" {
		s = handle
	}
	if s == "" {
		return "?"
	}
	return strings.ToUpper(string([]rune(s)[0]))
}

const heightScript = `(function(){var last=0;function send(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(h!==last){last=h;parent.postMessage({type:'sp:height',height:h},'*');}}if(window.ResizeObserver){new ResizeObserver(send).observe(document.documentElement);}window.addEventListener('load',send);send();})();`

func wallStyles(vars map[string]string) string {
	var v strings.Builder
	for _, k := range allowedCSS {
		if s, ok := vars[k]; ok {
			v.WriteString(k + ":" + s + ";")
		}
	}
	return `:root{--sp-bg:#fff;--sp-card:#fff;--sp-ink:#18181b;--sp-muted:#71717a;` +
		`--sp-border:#e4e4e7;--sp-accent:#2563eb;--sp-radius:10px;` +
		`--sp-font:ui-sans-serif,system-ui,sans-serif;` + v.String() + `}` +
		`[data-sp-theme=dark]{--sp-bg:#0f0f12;--sp-card:#17171b;--sp-ink:#ededf0;--sp-muted:#9a9aa4;--sp-border:#2a2a31}` +
		`@media(prefers-color-scheme:dark){[data-sp-theme=auto]{--sp-bg:#0f0f12;--sp-card:#17171b;--sp-ink:#ededf0;--sp-muted:#9a9aa4;--sp-border:#2a2a31}}` +
		`*{box-sizing:border-box}body{margin:0;background:var(--sp-bg);color:var(--sp-ink);font-family:var(--sp-font);font-size:14px;line-height:1.5}` +
		`.sp-wall{display:grid;gap:12px;padding:12px}` +
		`.sp-wall[data-sp-layout=grid]{grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}` +
		`.sp-wall[data-sp-density=compact]{gap:8px;padding:8px}` +
		`.sp-card{margin:0;background:var(--sp-card);border:1px solid var(--sp-border);border-radius:var(--sp-radius);padding:14px}` +
		`.sp-head{display:flex;gap:9px;align-items:center;margin-bottom:8px}` +
		`.sp-initials{width:36px;height:36px;border-radius:99px;background:var(--sp-border);color:var(--sp-muted);display:flex;align-items:center;justify-content:center;font-weight:600}` +
		`.sp-who{display:flex;flex-direction:column}.sp-name{font-weight:600}` +
		`.sp-handle,.sp-date{color:var(--sp-muted);font-size:12px}` +
		`.sp-body{margin:0;font-size:14px}` +
		`.sp-foot{display:flex;gap:10px;align-items:center;margin-top:9px;font-size:12px}` +
		`.sp-link{color:var(--sp-accent)}` +
		`.sp-wall[data-sp-dates=off] .sp-date{display:none}`
}

func wallCard(it WallItem) string {
	name := it.AuthorName
	if name == "" {
		name = it.AuthorHandle
	}
	handle := ""
	if it.AuthorHandle != "" {
		handle = fmt.Sprintf(`<span class="sp-handle">@%s</span>`, esc(it.AuthorHandle))
	}
	date := ""
	if it.PostedAt != nil {
		date = fmt.Sprintf(`<span class="sp-date">%s</span>`, esc(it.PostedAt.Format("Jan 2, 2006")))
	}
	// rel=noopener is not optional: the iframe is sandboxed with
	// allow-popups-to-escape-sandbox, so an opened tab must not keep a handle
	// back to this document.
	return fmt.Sprintf(`<figure class="sp-card">`+
		`<div class="sp-head"><span class="sp-initials" aria-hidden="true">%s</span>`+
		`<span class="sp-who"><span class="sp-name">%s</span>%s</span></div>`+
		`<blockquote class="sp-body">%s</blockquote>`+
		`<figcaption class="sp-foot">%s<a class="sp-link" href="%s" target="_blank" `+
		`rel="noopener noreferrer nofollow ugc">View original</a></figcaption></figure>`,
		esc(initials(it.AuthorName, it.AuthorHandle)), esc(name), handle,
		esc(it.Content), date, esc(it.URL))
}

func RenderWallHTML(w *Wall, items []WallItem, nonce string) string {
	body := `<p class="sp-empty"></p>` // an empty wall renders nothing, not an error
	if len(items) > 0 {
		var b strings.Builder
		for _, it := range items {
			b.WriteString(wallCard(it))
		}
		body = b.String()
	}
	dates := "off"
	if w.ShowDates {
		dates = "on"
	}
	return fmt.Sprintf(`<!doctype html>
<html lang="en" data-sp-theme="%s">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Testimonials</title>
<style nonce="%s">%s</style>
</head>
<body>
<div class="sp-wall" data-sp-layout="%s" data-sp-density="%s" data-sp-dates="%s">%s</div>
<script nonce="%s">%s</script>
</body>
</html>`, esc(w.Theme), nonce, wallStyles(ParseCSSVars(w.CSSVarsRaw)),
		esc(w.Layout), esc(w.Density), dates, body, nonce, heightScript)
}

// ---------- public routes (no auth, no Datastar) ----------

func serveEmbed(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		row, owner, ok := store.LoadWall(r.PathValue("id"))
		// An unknown or disabled wall gets a 404 the browser renders as an
		// empty frame. The customer's page shows nothing rather than our error.
		if !ok {
			http.Error(w, "Not found", 404)
			return
		}
		applyOverrides(row, r.URL.Query())
		items := store.LoadWallItems(owner, row.MaxItems)

		// Per-request nonce. It is what allows the single inline stylesheet and
		// the single height-reporting script to run under an otherwise empty
		// CSP, without ever resorting to 'unsafe-inline'.
		nonce := strings.ReplaceAll(newID(), "-", "")
		allowed := ParseAllowedDomains(row.AllowedDomainsRaw)
		h := w.Header()
		h.Set("Content-Type", "text/html; charset=utf-8")
		// frame-ancestors is delivered by THIS response's headers, so a cached
		// copy keeps enforcing whatever policy was current when it was stored.
		// The original ships `public, max-age=60` unconditionally: tightening a
		// wall's allow-list then does not bite until the cached copy expires,
		// and nothing can invalidate what is already stored. Revalidating every
		// time is the only policy under which a restriction takes effect at
		// once. The document is small and carries a per-request nonce, so there
		// was never much to cache.
		h.Set("Cache-Control", "no-cache")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", strings.Join([]string{
			"default-src 'none'",
			"img-src 'self' data:",
			"style-src 'nonce-" + nonce + "'",
			"script-src 'nonce-" + nonce + "'",
			"base-uri 'none'",
			"form-action 'none'",
			"frame-ancestors " + frameAncestors(allowed),
		}, "; "))
		fmt.Fprint(w, RenderWallHTML(row, items, nonce))
	}
}

func serveWallAPI(store *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		row, owner, ok := store.LoadWall(r.PathValue("id"))
		if !ok {
			http.Error(w, `{"error":"not found"}`, 404)
			return
		}
		origin := r.Header.Get("Origin")
		allowed := ParseAllowedDomains(row.AllowedDomainsRaw)
		if !IsOriginAllowed(origin, allowed) {
			http.Error(w, `{"error":"origin not allowed"}`, 403)
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		} else if allowed == nil {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		}
		items := store.LoadWallItems(owner, row.MaxItems)
		type outItem struct {
			ID, Platform, Content, URL string
			Author                     map[string]string
			PostedAt                   *int64 `json:",omitempty"`
		}
		out := struct {
			Wall  map[string]any `json:"wall"`
			Items []outItem      `json:"items"`
		}{Wall: map[string]any{
			"id": row.ID, "layout": row.Layout, "theme": row.Theme,
			"density": row.Density, "showDates": row.ShowDates,
			"cssVars": ParseCSSVars(row.CSSVarsRaw),
		}}
		for _, it := range items {
			var p *int64
			if it.PostedAt != nil {
				ms := it.PostedAt.UnixMilli()
				p = &ms
			}
			out.Items = append(out.Items, outItem{it.ID, it.Platform, it.Content, it.URL,
				map[string]string{"handle": it.AuthorHandle, "name": it.AuthorName}, p})
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=60")
		_ = json.NewEncoder(w).Encode(out)
	}
}

// ---------- dashboard rendering ----------

func RenderWalls(ws []Wall, origin string) string {
	var b strings.Builder
	b.WriteString(`<div id="walls">`)
	if len(ws) == 0 {
		b.WriteString(`<div class="empty"><h2>No walls yet</h2>` +
			`<p>Create one to get an embed snippet for your site.</p></div>`)
	}
	for _, w := range ws {
		state, cls := "Live", "ok"
		if !w.Enabled {
			state, cls = "Paused", ""
		}
		domains := ParseAllowedDomains(w.AllowedDomainsRaw)
		domainText := ""
		if domains != nil {
			domainText = strings.Join(domains, ", ")
		}
		snippet := fmt.Sprintf(`<iframe src="%s/embed/%s" style="width:100%%;border:0" loading="lazy" title="Testimonials"></iframe>`,
			origin, w.ID)
		b.WriteString(fmt.Sprintf(`<article class="t wall" id="wall-%s"><div class="who"><div>`+
			`<div class="meta"><span class="name">%s</span><span class="plat">%s</span>`+
			`<code class="mono">%s</code></div>`+
			`<div class="foot"><a href="/embed/%s" target="_blank" rel="noopener">Preview</a>`+
			`<span>%s</span></div>`+
			`<label class="snippet"><span>Embed snippet</span>`+
			`<textarea rows="2" readonly onclick="this.select()">%s</textarea></label>`+
			`<label class="snippet"><span>Allowed domains <em>(blank = any site)</em></span>`+
			`<input type="text" value="%s" data-on:change__debounce.400ms="@patch('/walls/%s?domains=' + encodeURIComponent(evt.target.value))" placeholder="example.com, *.shop.example.com"></label>`+
			`</div></div><div class="acts">`+
			`<button class="btn sm" data-on:click="@patch('/walls/%s?enabled=%t')">%s</button>`+
			`<button class="btn sm danger" data-on:click="@delete('/walls/%s')">Delete</button>`+
			`</div></article>`,
			esc(w.ID), esc(w.Name), esc(state), esc(w.ID), esc(w.ID),
			map[bool]string{true: "Visible on any site", false: "Restricted"}[domains == nil],
			esc(snippet), esc(domainText), esc(w.ID),
			esc(w.ID), !w.Enabled, map[bool]string{true: "Pause", false: "Enable"}[w.Enabled],
			esc(w.ID)))
		_ = cls
	}
	b.WriteString(`</div>`)
	return b.String()
}

func RenderWallMsg(kind, text string) string {
	if kind == "" {
		return `<div id="wall-msg"></div>`
	}
	return fmt.Sprintf(`<div id="wall-msg"><div class="alert %s" role="%s">%s</div></div>`,
		kind, map[string]string{"ok": "status", "err": "alert"}[kind], text)
}

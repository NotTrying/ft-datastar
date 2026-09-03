package main

// HTML fragments. Each has a stable id — that id is what Datastar morphs
// against, so the same function serves both the first page render and every
// later SSE patch. There is no second "client-side" version of any of this.

import (
	"fmt"
	"html"
	"strings"
)

func esc(s string) string { return html.EscapeString(s) }

func RenderStats(c map[string]int) string {
	return fmt.Sprintf(`<div id="stats" class="stats">`+
		`<div class="stat pending"><b>%d</b><span>Pending</span></div>`+
		`<div class="stat approved"><b>%d</b><span>Approved</span></div>`+
		`<div class="stat dismissed"><b>%d</b><span>Dismissed</span></div></div>`,
		c["pending"], c["approved"], c["dismissed"])
}

func RenderTabs(c map[string]int, active string) string {
	var b strings.Builder
	b.WriteString(`<div id="tabs" class="tabs" role="tablist">`)
	for _, t := range []struct{ key, label string }{
		{"pending", "Pending"}, {"approved", "Approved"}, {"dismissed", "Dismissed"},
	} {
		b.WriteString(fmt.Sprintf(
			`<button class="tab" role="tab" aria-selected="%t" `+
				`data-on:click="$tab = '%s'; @get('/testimonials')">%s (%d)</button>`,
			t.key == active, t.key, t.label, c[t.key]))
	}
	b.WriteString(`</div>`)
	return b.String()
}

func RenderList(items []Testimonial, tab string, total int) string {
	var b strings.Builder

	if total == 0 {
		b.WriteString(`<div id="list" class="empty"><h2>Nothing here yet</h2>` +
			`<p>Add a review you already have using the panel above, or add an X handle ` +
			`and we&rsquo;ll find posts that mention it.</p></div>`)
		return b.String()
	}
	if len(items) == 0 {
		return fmt.Sprintf(`<div id="list" class="empty"><p>No %s testimonials</p></div>`, esc(tab))
	}

	b.WriteString(`<div id="list" class="list">`)
	for _, t := range items {
		name := t.AuthorName
		if name == "" {
			name = t.AuthorHandle
		}
		if name == "" {
			name = "Unknown"
		}
		initial := "?"
		if r := []rune(name); len(r) > 0 {
			initial = strings.ToUpper(string(r[0]))
		}

		b.WriteString(`<article class="t"><div class="who">`)
		b.WriteString(fmt.Sprintf(`<div class="av">%s</div><div>`, esc(initial)))
		b.WriteString(`<div class="meta">`)
		b.WriteString(fmt.Sprintf(`<span class="name">%s</span>`, esc(name)))
		if t.AuthorHandle != "" {
			b.WriteString(fmt.Sprintf(`<span class="handle">@%s</span>`, esc(t.AuthorHandle)))
		}
		b.WriteString(fmt.Sprintf(`<span class="plat">%s</span></div>`, esc(t.Platform)))
		b.WriteString(fmt.Sprintf(`<p>%s</p><div class="foot">`, esc(t.Content)))
		if t.PostedAt != nil {
			b.WriteString(fmt.Sprintf(`<span>%s</span>`, t.PostedAt.Format("Jan 2, 2006")))
		}
		// rel=noopener: this href is user-supplied and points off-site.
		b.WriteString(fmt.Sprintf(
			`<a href="%s" target="_blank" rel="noopener noreferrer">View original</a>`,
			esc(t.PostURL)))
		b.WriteString(`</div></div></div><div class="acts">`)

		switch t.Status {
		case "pending":
			b.WriteString(btn(t.ID, "approved", "Approve", "btn sm ok"))
			b.WriteString(btn(t.ID, "dismissed", "Dismiss", "btn sm"))
		case "approved":
			b.WriteString(del(t.ID))
		default:
			b.WriteString(btn(t.ID, "approved", "Approve", "btn sm"))
			b.WriteString(del(t.ID))
		}
		b.WriteString(`</div></article>`)
	}
	b.WriteString(`</div>`)
	return b.String()
}

func btn(id, status, label, cls string) string {
	return fmt.Sprintf(`<button class="%s" data-on:click="@patch('/testimonials/%s?status=%s')">%s</button>`,
		cls, esc(id), status, label)
}

func del(id string) string {
	return fmt.Sprintf(`<button class="btn sm danger" data-on:click="@delete('/testimonials/%s')">Remove</button>`,
		esc(id))
}

func RenderMsg(kind, text string) string {
	if kind == "" {
		return `<div id="form-msg"></div>`
	}
	return fmt.Sprintf(`<div id="form-msg"><div class="alert %s" role="%s">%s</div></div>`,
		kind, map[string]string{"ok": "status", "err": "alert"}[kind], text)
}

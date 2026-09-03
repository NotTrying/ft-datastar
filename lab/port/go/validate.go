package main

// Port of src/lib/server/manual-testimonial.ts.
//
// The one rule it will not bend on: a manual testimonial still needs a public
// source URL. The product's claim is that every quote on a wall resolves to a
// live original — allowing a quote with no source would keep the marketing and
// quietly discard the thing it describes.
//
// Pure: no database, no fetch. The caller does the insert.

import (
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	maxContent = 2000
	maxName    = 100
	maxURL     = 2048
)

type ManualInput struct {
	Content      string `json:"content"`
	AuthorName   string `json:"authorName"`
	AuthorHandle string `json:"authorHandle"`
	SourceURL    string `json:"sourceUrl"`
	PostedAt     string `json:"postedAt"`
}

type Row struct {
	Source, Platform, PostID, PostURL string
	AuthorHandle, AuthorName          string // "" means NULL
	Content                           string
	PostedAt                          *time.Time
}

type Invalid struct{ Field, Message string }

// Hosts we can name. Anything else is "web", which is honest rather than wrong.
var hosts = []struct {
	rx   *regexp.Regexp
	name string
}{
	{regexp.MustCompile(`^(www\.|mobile\.)?(x|twitter)\.com$`), "x"},
	{regexp.MustCompile(`(^|\.)facebook\.com$`), "facebook"},
	{regexp.MustCompile(`(^|\.)instagram\.com$`), "instagram"},
	{regexp.MustCompile(`(^|\.)linkedin\.com$`), "linkedin"},
	{regexp.MustCompile(`(^|\.)(google\.[a-z.]+|g\.page|goo\.gl)$`), "google"},
	{regexp.MustCompile(`(^|\.)productreview\.com\.au$`), "productreview"},
	{regexp.MustCompile(`(^|\.)trustpilot\.com$`), "trustpilot"},
	{regexp.MustCompile(`(^|\.)bsky\.app$`), "bluesky"},
	{regexp.MustCompile(`(^|\.)news\.ycombinator\.com$`), "hackernews"},
}

func platformFor(host string) string {
	h := strings.ToLower(host)
	for _, e := range hosts {
		if e.rx.MatchString(h) {
			return e.name
		}
	}
	return "web"
}

// A stable identity for the source, used as post_id. The unique index on
// (user_id, platform, post_id) then rejects the same review entered twice —
// in the database, not in a check the write path could forget.
func normaliseURL(u *url.URL) string {
	u.Fragment = ""
	u.RawFragment = ""
	u.Host = strings.ToLower(u.Host)
	if len(u.Path) > 1 && strings.HasSuffix(u.Path, "/") {
		u.Path = strings.TrimSuffix(u.Path, "/")
	}
	return u.String()
}

func ValidateManual(in ManualInput) (*Row, *Invalid) {
	content := strings.TrimSpace(in.Content)
	if content == "" {
		return nil, &Invalid{"content", "Enter what the customer said."}
	}
	if len([]rune(content)) > maxContent {
		return nil, &Invalid{"content",
			"That is longer than 2000 characters. Trim it to the part worth showing."}
	}

	authorName := strings.TrimSpace(in.AuthorName)
	authorHandle := strings.TrimPrefix(strings.TrimSpace(in.AuthorHandle), "@")
	if authorName == "" && authorHandle == "" {
		return nil, &Invalid{"authorName",
			"Give a name or a handle — a quote with neither cannot be attributed."}
	}
	if len([]rune(authorName)) > maxName || len([]rune(authorHandle)) > maxName {
		return nil, &Invalid{"authorName", "Name and handle are limited to 100 characters."}
	}

	raw := strings.TrimSpace(in.SourceURL)
	if raw == "" {
		return nil, &Invalid{"sourceUrl",
			"A link to the original is required — it is what makes the wall verifiable."}
	}
	if len(raw) > maxURL {
		return nil, &Invalid{"sourceUrl", "That link is too long."}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return nil, &Invalid{"sourceUrl", "That is not a valid link."}
	}
	// Anything but http(s) — javascript:, data:, file: — is refused outright
	// rather than sanitised later, because this value ends up as an href on
	// someone else's website. Checked before the host test so that a
	// `javascript:` payload gets this message rather than "not a valid link".
	if u.Scheme != "https" && u.Scheme != "http" {
		return nil, &Invalid{"sourceUrl", "The link must start with http:// or https://."}
	}
	if u.Host == "" {
		return nil, &Invalid{"sourceUrl", "That is not a valid link."}
	}

	var postedAt *time.Time
	if d := strings.TrimSpace(in.PostedAt); d != "" {
		t, err := time.Parse("2006-01-02", d)
		if err != nil {
			if t, err = time.Parse(time.RFC3339, d); err != nil {
				return nil, &Invalid{"postedAt", "That is not a valid date."}
			}
		}
		// A testimonial from the future is a typo, and it would sort above
		// every real one on the wall.
		if t.After(time.Now().Add(24 * time.Hour)) {
			return nil, &Invalid{"postedAt", "That date is in the future."}
		}
		postedAt = &t
	}

	postURL := normaliseURL(u)
	return &Row{
		Source: "manual", Platform: platformFor(u.Hostname()),
		PostID: postURL, PostURL: postURL,
		AuthorHandle: authorHandle, AuthorName: authorName,
		Content: content, PostedAt: postedAt,
	}, nil
}

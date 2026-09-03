package main

// Walls: the public read path. Ported from src/lib/server/walls.ts.
//
// Everything here runs for anonymous visitors on somebody else's website, so
// the rules are stricter than the dashboard's: validate on the way OUT as well
// as in, because a row written months ago under looser code still renders on a
// customer's site today.

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const wallsSchema = `
CREATE TABLE IF NOT EXISTS wall (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  layout          TEXT NOT NULL DEFAULT 'grid',
  theme           TEXT NOT NULL DEFAULT 'light',
  density         TEXT NOT NULL DEFAULT 'comfortable',
  show_dates      INTEGER NOT NULL DEFAULT 1,
  max_items       INTEGER NOT NULL DEFAULT 12,
  allowed_domains TEXT,
  css_vars        TEXT,
  created_at      INTEGER NOT NULL
);
`

var (
	layouts    = []string{"grid", "column", "carousel"}
	themes     = []string{"light", "dark", "auto"}
	densities  = []string{"comfortable", "compact"}
	allowedCSS = []string{"--sp-bg", "--sp-card", "--sp-ink", "--sp-muted",
		"--sp-border", "--sp-accent", "--sp-radius", "--sp-font"}
)

// A conservative value charset. These end up inside a `style` attribute, so
// anything that could close a declaration, open a comment, or fetch a remote
// resource is rejected outright.
var (
	cssValueRx = regexp.MustCompile(`^[a-zA-Z0-9#%.,()\-_ /]{1,64}$`)
	cssDenyRx  = regexp.MustCompile(`(?i)url\(|expression\(|@import|/\*`)
	hostRx     = regexp.MustCompile(`^[a-z0-9-]+(\.[a-z0-9-]+)+$`)
)

func IsSafeCSSValue(v string) bool {
	return cssValueRx.MatchString(v) && !cssDenyRx.MatchString(v)
}

// Never fails: a corrupt or hostile value yields an empty map rather than
// breaking the wall.
func ParseCSSVars(raw string) map[string]string {
	out := map[string]string{}
	if raw == "" {
		return out
	}
	var parsed map[string]any
	if json.Unmarshal([]byte(raw), &parsed) != nil {
		return out
	}
	for _, k := range allowedCSS {
		if s, ok := parsed[k].(string); ok && IsSafeCSSValue(s) {
			out[k] = s
		}
	}
	return out
}

// nil means "not yet restricted", which is distinct from an empty slice — an
// empty list allows nothing.
func ParseAllowedDomains(raw string) []string {
	if raw == "" {
		return nil
	}
	var parsed []string
	if json.Unmarshal([]byte(raw), &parsed) != nil {
		return nil
	}
	out := []string{}
	for _, d := range parsed {
		if d != "" {
			out = append(out, d)
		}
	}
	return out
}

func normalizeHost(h string) string {
	return strings.ToLower(strings.TrimPrefix(strings.ToLower(h), "www."))
}

// A browser-level control enforced through CORS and frame-ancestors. It stops
// a wall id being lifted onto another site; it is not a secrecy boundary, and
// it cannot be — the payload is testimonials the owner publishes publicly.
func IsOriginAllowed(origin string, allowed []string) bool {
	if allowed == nil {
		return true
	}
	if len(allowed) == 0 || origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" {
		return false
	}
	host := normalizeHost(u.Hostname())
	for _, e := range allowed {
		t := strings.TrimSpace(e)
		if strings.HasPrefix(t, "*.") {
			base := normalizeHost(t[2:])
			if host == base || strings.HasSuffix(host, "."+base) {
				return true
			}
		} else if host == normalizeHost(t) {
			return true
		}
	}
	return false
}

// Accepts what a person actually types — a full URL, a bare host, with or
// without www., separated by commas or newlines — and stores the bare
// hostname. nil for empty input means "unrestricted"; that distinction is
// load-bearing (see IsOriginAllowed).
func ParseDomainInput(raw string) []string {
	parts := regexp.MustCompile(`[\s,]+`).Split(strings.TrimSpace(raw), -1)
	var out []string
	for _, p := range parts {
		host := strings.TrimSpace(p)
		if host == "" {
			continue
		}
		if strings.Contains(host, "://") {
			u, err := url.Parse(host)
			if err != nil {
				continue
			}
			host = u.Hostname()
		}
		host = strings.ToLower(strings.TrimLeft(strings.Split(strings.Split(host, "/")[0], ":")[0], "."))
		wildcard := strings.HasPrefix(host, "*.")
		bare := strings.TrimPrefix(host, "*.")
		// A hostname, not free text. Anything else is a typo and is dropped.
		if !hostRx.MatchString(bare) {
			continue
		}
		entry := bare
		if wildcard {
			entry = "*." + bare
		}
		if !contains(out, entry) {
			out = append(out, entry)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// This value ends up pasted into a customer's HTML, so it is not a secret —
// but it should not be guessable either.
func GenerateWallID() string {
	b := make([]byte, 13)
	_, _ = rand.Read(b)
	var sb strings.Builder
	for _, x := range b {
		sb.WriteString(fmt.Sprintf("%02s", strconvBase32(x)))
	}
	return "wl_" + sb.String()[:20]
}

func strconvBase32(b byte) string {
	const digits = "0123456789abcdefghijklmnopqrstuv"
	if b < 32 {
		return string(digits[b])
	}
	return string(digits[b/32]) + string(digits[b%32])
}

// ---------- store ----------

type Wall struct {
	ID, Name, Layout, Theme, Density string
	Enabled, ShowDates               bool
	MaxItems                         int
	AllowedDomainsRaw, CSSVarsRaw    string
}

type WallItem struct {
	ID, Platform, Content, URL string
	AuthorHandle, AuthorName   string
	PostedAt                   *time.Time
}

func (s *Store) CreateWall(userID, name string) (string, error) {
	id := GenerateWallID()
	_, err := s.db.Exec(`INSERT INTO wall (id, user_id, name, created_at) VALUES (?,?,?,?)`,
		id, userID, name, time.Now().UnixMilli())
	return id, err
}

func scanWalls(rows interface {
	Next() bool
	Scan(...any) error
	Close() error
}) []Wall {
	defer rows.Close()
	var out []Wall
	for rows.Next() {
		var w Wall
		var enabled, dates int
		var domains, css *string
		if rows.Scan(&w.ID, &w.Name, &enabled, &w.Layout, &w.Theme, &w.Density,
			&dates, &w.MaxItems, &domains, &css) != nil {
			continue
		}
		w.Enabled, w.ShowDates = enabled == 1, dates == 1
		if domains != nil {
			w.AllowedDomainsRaw = *domains
		}
		if css != nil {
			w.CSSVarsRaw = *css
		}
		out = append(out, w)
	}
	return out
}

const wallCols = `id, name, enabled, layout, theme, density, show_dates, max_items, allowed_domains, css_vars`

func (s *Store) ListWalls(userID string) []Wall {
	rows, err := s.db.Query(`SELECT `+wallCols+` FROM wall WHERE user_id = ? ORDER BY created_at`, userID)
	if err != nil {
		return nil
	}
	return scanWalls(rows)
}

// LoadWall is the public read: no user scoping, because the visitor is
// anonymous. A disabled wall is indistinguishable from a missing one.
func (s *Store) LoadWall(id string) (*Wall, string, bool) {
	rows, err := s.db.Query(`SELECT `+wallCols+` FROM wall WHERE id = ?`, id)
	if err != nil {
		return nil, "", false
	}
	ws := scanWalls(rows)
	if len(ws) == 0 || !ws[0].Enabled {
		return nil, "", false
	}
	var owner string
	_ = s.db.QueryRow(`SELECT user_id FROM wall WHERE id = ?`, id).Scan(&owner)
	return &ws[0], owner, true
}

func (s *Store) SetWallEnabled(userID, id string, on bool) bool {
	v := 0
	if on {
		v = 1
	}
	res, err := s.db.Exec(`UPDATE wall SET enabled = ? WHERE id = ? AND user_id = ?`, v, id, userID)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n > 0
}

func (s *Store) SetWallDomains(userID, id string, domains []string) bool {
	var val any
	if domains != nil {
		b, _ := json.Marshal(domains)
		val = string(b)
	}
	res, err := s.db.Exec(`UPDATE wall SET allowed_domains = ? WHERE id = ? AND user_id = ?`, val, id, userID)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n > 0
}

func (s *Store) DeleteWall(userID, id string) bool {
	res, err := s.db.Exec(`DELETE FROM wall WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n > 0
}

// Two filters carry the product's whole claim: `approved` (the owner chose it)
// and verify_state != 'gone' (the original still resolves).
func (s *Store) LoadWallItems(ownerID string, max int) []WallItem {
	if max < 1 {
		max = 1
	}
	if max > 100 {
		max = 100
	}
	rows, err := s.db.Query(`
		SELECT id, platform, content, post_url, coalesce(author_handle,''),
		       coalesce(author_name,''), posted_at
		  FROM testimonial
		 WHERE user_id = ? AND status = 'approved' AND coalesce(verify_state,'unknown') != 'gone'
		 ORDER BY posted_at DESC, created_at DESC LIMIT ?`, ownerID, max)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []WallItem
	for rows.Next() {
		var it WallItem
		var posted *int64
		if rows.Scan(&it.ID, &it.Platform, &it.Content, &it.URL,
			&it.AuthorHandle, &it.AuthorName, &posted) != nil {
			continue
		}
		if posted != nil {
			t := time.UnixMilli(*posted)
			it.PostedAt = &t
		}
		out = append(out, it)
	}
	return out
}

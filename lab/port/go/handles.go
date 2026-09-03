package main

// Monitored handles + plan limits. Ported from
// src/routes/(member)/dashboard/handles/+page.server.ts and lib/config/pricing.ts.

import (
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const handlesSchema = `
CREATE TABLE IF NOT EXISTS monitored_handle (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  platform        TEXT NOT NULL,
  handle          TEXT NOT NULL,
  last_scanned_at INTEGER,
  last_post_id    TEXT,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS handle_dedupe
  ON monitored_handle (user_id, platform, handle);

-- The original counts testimonials created this month against scansPerMonth.
-- That under-counts scans that find nothing and over-counts manual additions,
-- so this port logs scans properly. See README-SCAN.md.
CREATE TABLE IF NOT EXISTS scan_log (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL,
  handle_id TEXT NOT NULL,
  at        INTEGER NOT NULL
);
`

// ---------- plans (mirrors src/lib/config/pricing.ts) ----------

type Limits struct{ MaxHandles, ScansPerMonth, MaxTestimonials int }

var plans = map[string]Limits{
	"free":       {MaxHandles: 1, ScansPerMonth: 30, MaxTestimonials: 10},
	"pro":        {MaxHandles: 5, ScansPerMonth: 500, MaxTestimonials: 200},
	"enterprise": {MaxHandles: -1, ScansPerMonth: -1, MaxTestimonials: -1},
}

// -1 means unlimited, matching canUseLimit() in the original.
func canUse(limit, used int) bool { return limit == -1 || used < limit }

func (s *Store) LimitsFor(userID string) Limits {
	var plan string
	_ = s.db.QueryRow(`SELECT plan FROM app_user WHERE id = ?`, userID).Scan(&plan)
	if l, ok := plans[plan]; ok {
		return l
	}
	return plans["free"]
}

// ---------- validation (ported verbatim from the original's addHandle) ----------

var handleRx = regexp.MustCompile(`^[a-zA-Z0-9_]+$`)

func ValidateHandle(raw string) (string, error) {
	h := strings.TrimPrefix(strings.TrimSpace(raw), "@")
	if h == "" {
		return "", errors.New("Handle is required")
	}
	if len(h) < 1 || len(h) > 50 {
		return "", errors.New("Handle must be between 1 and 50 characters")
	}
	if !handleRx.MatchString(h) {
		return "", errors.New("Handle can only contain letters, numbers, and underscores")
	}
	return h, nil
}

// ---------- store ----------

type Handle struct {
	ID, Platform, Name string
	LastScannedAt      *time.Time
	LastPostID         string
	Pending, Approved  int
}

func (s *Store) CountHandles(userID string) int {
	var n int
	_ = s.db.QueryRow(`SELECT count(*) FROM monitored_handle WHERE user_id = ?`, userID).Scan(&n)
	return n
}

func (s *Store) AddHandle(userID, name string) error {
	_, err := s.db.Exec(
		`INSERT INTO monitored_handle (id, user_id, platform, handle, created_at) VALUES (?,?,?,?,?)`,
		newID(), userID, "x", name, time.Now().UnixMilli())
	if err != nil && strings.Contains(strings.ToUpper(err.Error()), "UNIQUE") {
		return ErrDuplicate
	}
	return err
}

func (s *Store) ListHandles(userID string) []Handle {
	rows, err := s.db.Query(`
		SELECT h.id, h.platform, h.handle, h.last_scanned_at, coalesce(h.last_post_id,''),
		       (SELECT count(*) FROM testimonial t WHERE t.handle_id = h.id AND t.status='pending'),
		       (SELECT count(*) FROM testimonial t WHERE t.handle_id = h.id AND t.status='approved')
		  FROM monitored_handle h WHERE h.user_id = ? ORDER BY h.created_at`, userID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []Handle
	for rows.Next() {
		var h Handle
		var last sql.NullInt64
		if rows.Scan(&h.ID, &h.Platform, &h.Name, &last, &h.LastPostID, &h.Pending, &h.Approved) != nil {
			continue
		}
		if last.Valid {
			t := time.UnixMilli(last.Int64)
			h.LastScannedAt = &t
		}
		out = append(out, h)
	}
	return out
}

func (s *Store) HandleByID(userID, id string) (*Handle, bool) {
	for _, h := range s.ListHandles(userID) {
		if h.ID == id {
			return &h, true
		}
	}
	return nil, false
}

func (s *Store) DeleteHandle(userID, id string) bool {
	// Testimonials cascade in the original via FK; done explicitly here.
	_, _ = s.db.Exec(`DELETE FROM testimonial WHERE handle_id = ? AND user_id = ?`, id, userID)
	res, err := s.db.Exec(`DELETE FROM monitored_handle WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n > 0
}

func (s *Store) TouchHandle(id, lastPostID string) {
	_, _ = s.db.Exec(`UPDATE monitored_handle SET last_scanned_at = ?, last_post_id = ? WHERE id = ?`,
		time.Now().UnixMilli(), lastPostID, id)
}

func (s *Store) LogScan(userID, handleID string) {
	_, _ = s.db.Exec(`INSERT INTO scan_log (id, user_id, handle_id, at) VALUES (?,?,?,?)`,
		newID(), userID, handleID, time.Now().UnixMilli())
}

func (s *Store) ScansThisMonth(userID string) int {
	now := time.Now()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	var n int
	_ = s.db.QueryRow(`SELECT count(*) FROM scan_log WHERE user_id = ? AND at >= ?`,
		userID, start.UnixMilli()).Scan(&n)
	return n
}

func (s *Store) KnownPostIDs(userID, platform string) map[string]bool {
	out := map[string]bool{}
	rows, err := s.db.Query(`SELECT post_id FROM testimonial WHERE user_id = ? AND platform = ?`,
		userID, platform)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			out[id] = true
		}
	}
	return out
}

func (s *Store) InsertScanned(userID, handleID string, m Mention) error {
	_, err := s.db.Exec(`
		INSERT INTO testimonial (id, user_id, handle_id, source, platform, post_id, post_url,
		                         author_handle, author_name, content, status, posted_at, created_at)
		VALUES (?,?,?,'scan',?,?,?,?,?,?,'pending',?,?)`,
		newID(), userID, handleID, m.Platform, m.PostID, m.PostURL,
		m.AuthorHandle, m.AuthorName, m.Content, m.PostedAt.UnixMilli(), time.Now().UnixMilli())
	if err != nil && strings.Contains(strings.ToUpper(err.Error()), "UNIQUE") {
		return ErrDuplicate
	}
	return err
}

// ---------- rendering ----------

func RenderHandles(hs []Handle, lim Limits) string {
	var b strings.Builder
	b.WriteString(`<div id="handles">`)
	if len(hs) == 0 {
		b.WriteString(`<div class="empty"><h2>No handles yet</h2>` +
			`<p>Add an X handle above and we&rsquo;ll look for posts that mention it.</p></div>`)
	}
	for _, h := range hs {
		last := "Never"
		if h.LastScannedAt != nil {
			last = h.LastScannedAt.Format("Jan 2, 15:04")
		}
		b.WriteString(fmt.Sprintf(
			`<article class="t handle" id="handle-%s"><div class="who"><div class="av">@</div><div>`+
				`<div class="meta"><span class="name">@%s</span><span class="plat">%s</span></div>`+
				`<div class="foot"><span>%d pending &middot; %d approved</span>`+
				`<span>Last scan: %s</span></div></div></div>`+
				`<div class="acts">`+
				`<button class="btn sm ok" data-on:click="@post('/scan?id=%s')" data-attr:disabled="$_scanning">Scan now</button>`+
				`<button class="btn sm danger" data-on:click="@delete('/handles/%s')" data-attr:disabled="$_scanning">Remove</button>`+
				`</div></article>`,
			esc(h.ID), esc(h.Name), esc(h.Platform), h.Pending, h.Approved, esc(last),
			esc(h.ID), esc(h.ID)))
	}
	b.WriteString(`</div>`)
	return b.String()
}

func RenderHandleMsg(kind, text string) string {
	if kind == "" {
		return `<div id="handle-msg"></div>`
	}
	return fmt.Sprintf(`<div id="handle-msg"><div class="alert %s" role="%s">%s</div></div>`,
		kind, map[string]string{"ok": "status", "err": "alert"}[kind], text)
}

func RenderPlan(used int, lim Limits) string {
	cap := "unlimited"
	if lim.MaxHandles != -1 {
		cap = fmt.Sprintf("%d", lim.MaxHandles)
	}
	return fmt.Sprintf(`<p id="plan-line" class="muted small">Monitoring %d of %s handles on your plan.</p>`,
		used, cap)
}

package main

// SQLite store. Mirrors the shape of the D1 `testimonial` table the SvelteKit
// app uses, including the unique index the dedupe check leans on.

import (
	"database/sql"
	"errors"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Testimonial struct {
	ID           string
	Source       string
	Platform     string
	PostURL      string
	AuthorHandle string
	AuthorName   string
	Content      string
	Status       string
	PostedAt     *time.Time
	CreatedAt    time.Time
}

const schema = `
CREATE TABLE IF NOT EXISTS testimonial (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  handle_id     TEXT,
  source        TEXT NOT NULL,
  platform      TEXT NOT NULL,
  post_id       TEXT NOT NULL,
  post_url      TEXT NOT NULL,
  author_handle TEXT,
  author_name   TEXT,
  content       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','dismissed')),
  verify_state  TEXT NOT NULL DEFAULT 'unknown',
  posted_at     INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS testimonial_dedupe
  ON testimonial (user_id, platform, post_id);
`

var ErrDuplicate = errors.New("duplicate")

type Store struct{ db *sql.DB }

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		return nil, err
	}
	if _, err := db.Exec(authSchema); err != nil {
		return nil, err
	}
	if _, err := db.Exec(handlesSchema); err != nil {
		return nil, err
	}
	if _, err := db.Exec(wallsSchema); err != nil {
		return nil, err
	}
	return &Store{db}, nil
}

func (s *Store) Counts(userID string) map[string]int {
	c := map[string]int{"pending": 0, "approved": 0, "dismissed": 0}
	rows, err := s.db.Query(
		`SELECT status, count(*) FROM testimonial WHERE user_id = ? GROUP BY status`, userID)
	if err != nil {
		return c
	}
	defer rows.Close()
	for rows.Next() {
		var st string
		var n int
		if rows.Scan(&st, &n) == nil {
			c[st] = n
		}
	}
	return c
}

func (s *Store) List(userID, status string) []Testimonial {
	rows, err := s.db.Query(`
		SELECT id, source, platform, post_url, coalesce(author_handle,''),
		       coalesce(author_name,''), content, status, posted_at, created_at
		  FROM testimonial WHERE user_id = ? AND status = ?
		 ORDER BY created_at DESC`, userID, status)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var out []Testimonial
	for rows.Next() {
		var t Testimonial
		var posted sql.NullInt64
		var created int64
		if err := rows.Scan(&t.ID, &t.Source, &t.Platform, &t.PostURL, &t.AuthorHandle,
			&t.AuthorName, &t.Content, &t.Status, &posted, &created); err != nil {
			continue
		}
		if posted.Valid {
			p := time.UnixMilli(posted.Int64)
			t.PostedAt = &p
		}
		t.CreatedAt = time.UnixMilli(created)
		out = append(out, t)
	}
	return out
}

func (s *Store) Insert(userID, id string, r *Row) error {
	var posted any
	if r.PostedAt != nil {
		posted = r.PostedAt.UnixMilli()
	}
	nz := func(v string) any {
		if v == "" {
			return nil
		}
		return v
	}
	_, err := s.db.Exec(`
		INSERT INTO testimonial (id, user_id, source, platform, post_id, post_url,
		                         author_handle, author_name, content, status, posted_at, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`,
		id, userID, r.Source, r.Platform, r.PostID, r.PostURL,
		nz(r.AuthorHandle), nz(r.AuthorName), r.Content, posted, time.Now().UnixMilli())
	if err != nil && strings.Contains(strings.ToUpper(err.Error()), "UNIQUE") {
		return ErrDuplicate
	}
	return err
}

// SetStatus and Delete are scoped by user_id as well as id: ownership is
// enforced in the WHERE clause, not in a check above it.
func (s *Store) SetStatus(userID, id, status string) bool {
	res, err := s.db.Exec(
		`UPDATE testimonial SET status = ? WHERE id = ? AND user_id = ?`, status, id, userID)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n > 0
}

func (s *Store) Delete(userID, id string) bool {
	res, err := s.db.Exec(`DELETE FROM testimonial WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n > 0
}

func (s *Store) EmailFor(userID string) string {
	var e string
	_ = s.db.QueryRow(`SELECT email FROM app_user WHERE id = ?`, userID).Scan(&e)
	return e
}

func (s *Store) UserID(email string) (string, bool) {
	var id string
	err := s.db.QueryRow(`SELECT id FROM app_user WHERE email = ?`, email).Scan(&id)
	return id, err == nil
}

func (s *Store) Count(userID string) int {
	var n int
	_ = s.db.QueryRow(`SELECT count(*) FROM testimonial WHERE user_id = ?`, userID).Scan(&n)
	return n
}

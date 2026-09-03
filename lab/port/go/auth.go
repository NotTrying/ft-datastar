package main

// Authentication. Datastar has nothing to say about this — it is a hypermedia
// layer, not a framework — so all of it is hand-rolled on the stdlib.
//
// Two Datastar-specific wrinkles drive the design:
//
//  1. A 302 is useless to an SSE request. `fetch` follows the redirect and
//     hands Datastar the login *page* as if it were an event stream. So an
//     expired session on a Datastar request has to answer with the documented
//     redirect: patch a <script> into the body.
//  2. Every signal on the page is sent with every request, so nothing
//     sensitive may ever live in one. Sessions live in an HttpOnly cookie the
//     page cannot read.

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	cookieName  = "sp_session"
	sessionTTL  = 7 * 24 * time.Hour
	pbkdf2Iters = 210_000
)

const authSchema = `
CREATE TABLE IF NOT EXISTS app_user (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  pw_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`

// ---------- password hashing (stdlib; Go 1.24 has crypto/pbkdf2) ----------

func hashPassword(pw string) string {
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	key, _ := pbkdf2.Key(sha256.New, pw, salt, pbkdf2Iters, 32)
	return fmt.Sprintf("pbkdf2_sha256$%d$%s$%s", pbkdf2Iters,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key))
}

func verifyPassword(pw, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2_sha256" {
		return false
	}
	iters, err := strconv.Atoi(parts[1])
	if err != nil {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[2])
	want, err2 := base64.RawStdEncoding.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pw, salt, iters, len(want))
	if err != nil {
		return false
	}
	// Constant time: a timing difference here leaks the hash a byte at a time.
	return subtle.ConstantTimeCompare(got, want) == 1
}

// ---------- sessions ----------

// The cookie holds the raw token; the database holds only its SHA-256. A dump
// of the session table therefore does not let anyone log in as anybody.
func tokenHash(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

func (s *Store) CreateUser(email, pw string) (string, error) {
	id := newID()
	_, err := s.db.Exec(
		`INSERT INTO app_user (id, email, pw_hash, created_at) VALUES (?,?,?,?)`,
		id, strings.ToLower(strings.TrimSpace(email)), hashPassword(pw), time.Now().UnixMilli())
	return id, err
}

func (s *Store) Authenticate(email, pw string) (string, bool) {
	var id, hash string
	err := s.db.QueryRow(`SELECT id, pw_hash FROM app_user WHERE email = ?`,
		strings.ToLower(strings.TrimSpace(email))).Scan(&id, &hash)
	if err == sql.ErrNoRows {
		// Hash anyway so a missing account and a wrong password take the same
		// time — otherwise the response time enumerates registered emails.
		verifyPassword(pw, "pbkdf2_sha256$210000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
		return "", false
	}
	if err != nil || !verifyPassword(pw, hash) {
		return "", false
	}
	return id, true
}

func (s *Store) NewSession(userID string) (string, time.Time) {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	tok := hex.EncodeToString(b)
	exp := time.Now().Add(sessionTTL)
	_, _ = s.db.Exec(`INSERT INTO session (token_hash, user_id, expires_at) VALUES (?,?,?)`,
		tokenHash(tok), userID, exp.UnixMilli())
	return tok, exp
}

func (s *Store) UserForToken(tok string) (string, bool) {
	var userID string
	var exp int64
	err := s.db.QueryRow(`SELECT user_id, expires_at FROM session WHERE token_hash = ?`,
		tokenHash(tok)).Scan(&userID, &exp)
	if err != nil {
		return "", false
	}
	if time.Now().UnixMilli() > exp {
		_, _ = s.db.Exec(`DELETE FROM session WHERE token_hash = ?`, tokenHash(tok))
		return "", false
	}
	return userID, true
}

func (s *Store) DropSession(tok string) {
	_, _ = s.db.Exec(`DELETE FROM session WHERE token_hash = ?`, tokenHash(tok))
}

// ---------- request plumbing ----------

func setSessionCookie(w http.ResponseWriter, r *http.Request, tok string, exp time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: tok, Path: "/", Expires: exp,
		HttpOnly: true,                 // the page cannot read it, so no signal can leak it
		SameSite: http.SameSiteLaxMode, // the CSRF baseline
		Secure:   r.TLS != nil,         // set unconditionally behind TLS in production
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
}

func isDatastar(r *http.Request) bool { return r.Header.Get("datastar-request") == "true" }

// SSE redirect. A 302 cannot move an SSE request, so the documented mechanism
// is to patch a <script> into the body. setTimeout keeps Firefox's back
// history intact (it would otherwise replace rather than push).
func sseRedirect(w http.ResponseWriter, to string) {
	s, ok := newSSE(w)
	if !ok {
		return
	}
	s.patchWith("selector body\ndata: mode append",
		fmt.Sprintf(`<script>setTimeout(() => window.location = %q)</script>`, to))
}

// CSRF. Datastar sends `datastar-request: true` and, on non-GET,
// `content-type: application/json`. Neither is a CORS "simple request", so a
// cross-origin page cannot make the browser send one without a preflight this
// server never approves. Origin is checked too where the browser supplies it.
//
// The rule this leans on: no GET in this app ever mutates. A GET *is* simple,
// and it carries every signal in the query string.
func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // no Origin header: not a cross-site browser request
	}
	return strings.TrimPrefix(strings.TrimPrefix(origin, "https://"), "http://") == r.Host
}

type authed func(w http.ResponseWriter, r *http.Request, userID string)

func requireUser(store *Store, next authed) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && (!isDatastar(r) || !sameOrigin(r)) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		c, err := r.Cookie(cookieName)
		if err == nil {
			if uid, ok := store.UserForToken(c.Value); ok {
				next(w, r, uid)
				return
			}
		}
		clearSessionCookie(w)
		if isDatastar(r) {
			sseRedirect(w, "/login") // an expired session mid-interaction
			return
		}
		http.Redirect(w, r, "/login", http.StatusFound)
	}
}

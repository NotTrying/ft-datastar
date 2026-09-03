package main

// Datastar port of the social-proof dashboard. Go 1.22+ stdlib routing,
// SQLite for storage, SSE for every update. No framework, no build step.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
)

// ---------- SSE ----------

type sse struct {
	w http.ResponseWriter
	f http.Flusher
}

func newSSE(w http.ResponseWriter) (*sse, bool) {
	f, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", 500)
		return nil, false
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	f.Flush()
	return &sse{w, f}, true
}

func (s *sse) patch(elems string) { s.patchWith("", elems) }

// opts is pre-formatted dataline text (e.g. "selector body\ndata: mode append").
// One `data: elements ` line per line of HTML — required by the spec. A single
// missing prefix makes the patch silently do nothing.
func (s *sse) patchWith(opts, elems string) {
	var b strings.Builder
	b.WriteString("event: datastar-patch-elements\n")
	if opts != "" {
		b.WriteString("data: " + opts + "\n")
	}
	for _, line := range strings.Split(strings.TrimRight(elems, "\n"), "\n") {
		b.WriteString("data: elements " + line + "\n")
	}
	b.WriteString("\n")
	fmt.Fprint(s.w, b.String())
	s.f.Flush()
}

func (s *sse) signals(j string) {
	fmt.Fprintf(s.w, "event: datastar-patch-signals\ndata: signals %s\n\n", j)
	s.f.Flush()
}

// ---------- signals in ----------

type incoming struct {
	Tab string `json:"tab"`
	ManualInput
}

func readSignals(r *http.Request) incoming {
	var in incoming
	raw := r.URL.Query().Get("datastar")
	if raw == "" && r.Body != nil {
		b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		raw = string(b)
	}
	if raw != "" {
		_ = json.Unmarshal([]byte(raw), &in)
	}
	if in.Tab != "pending" && in.Tab != "approved" && in.Tab != "dismissed" {
		in.Tab = "pending"
	}
	return in
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func main() {
	shared := os.Getenv("LAB_SHARED")
	if shared == "" {
		shared = "../shared"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	dbPath := os.Getenv("LAB_DB")
	if dbPath == "" {
		dbPath = "social-proof.db"
	}
	store, err := Open(dbPath + "?_pragma=busy_timeout(5000)")
	if err != nil {
		log.Fatal(err)
	}
	demoUser := SeedAccount(store)
	Seed(store, demoUser)

	page := func(w http.ResponseWriter, name string, subs ...string) {
		tpl, err := os.ReadFile(shared + "/" + name)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		out := strings.ReplaceAll(string(tpl), "__BACKEND__", "Go")
		for i := 0; i+1 < len(subs); i += 2 {
			out = strings.Replace(out, subs[i], subs[i+1], 1)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, out)
	}

	// Redraw the regions a mutation can affect. Targeted patches, not a
	// whole-page replace: Datastar morphs each by id.
	redraw := func(s *sse, uid, tab string) {
		c := store.Counts(uid)
		s.patch(RenderStats(c))
		s.patch(RenderTabs(c, tab))
		s.patch(RenderList(store.List(uid, tab), tab, store.Count(uid)))
	}

	mux := http.NewServeMux()

	// ---- public ----

	mux.HandleFunc("GET /datastar.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		http.ServeFile(w, r, shared+"/datastar.js")
	})
	mux.HandleFunc("GET /styles.css", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		http.ServeFile(w, r, shared+"/styles.css")
	})
	mux.HandleFunc("GET /favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("GET /login", func(w http.ResponseWriter, r *http.Request) {
		if c, err := r.Cookie(cookieName); err == nil {
			if _, ok := store.UserForToken(c.Value); ok {
				http.Redirect(w, r, "/", http.StatusFound)
				return
			}
		}
		page(w, "login.html")
	})

	// contentType:'form' means the password arrives as a form field, never as
	// a signal. See the comment at the top of shared/login.html.
	mux.HandleFunc("POST /login", func(w http.ResponseWriter, r *http.Request) {
		if !isDatastar(r) || !sameOrigin(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			_ = r.ParseForm()
		}
		// Order matters: newSSE flushes the response headers, so Set-Cookie
		// has to be written BEFORE the stream opens or it is silently dropped.
		uid, good := store.Authenticate(r.FormValue("email"), r.FormValue("password"))
		if good {
			tok, exp := store.NewSession(uid)
			setSessionCookie(w, r, tok, exp)
		}
		s, ok := newSSE(w)
		if !ok {
			return
		}
		if !good {
			// One message for both cases: saying which half was wrong
			// enumerates accounts.
			s.patch(`<div id="login-msg"><div class="alert err" role="alert">` +
				`That email and password do not match.</div></div>`)
			return
		}
		s.patchWith("selector body\ndata: mode append",
			`<script>setTimeout(() => window.location = "/")</script>`)
	})

	mux.HandleFunc("POST /logout", func(w http.ResponseWriter, r *http.Request) {
		if c, err := r.Cookie(cookieName); err == nil {
			store.DropSession(c.Value)
		}
		clearSessionCookie(w)
		if isDatastar(r) {
			sseRedirect(w, "/login")
			return
		}
		http.Redirect(w, r, "/login", http.StatusFound)
	})

	// ---- protected ----

	mux.HandleFunc("GET /{$}", requireUser(store, func(w http.ResponseWriter, r *http.Request, uid string) {
		c := store.Counts(uid)
		page(w, "dashboard.html",
			"__EMAIL__", esc(store.EmailFor(uid)),
			"__STATS__", RenderStats(c),
			"__TABS__", RenderTabs(c, "pending"),
			"__LIST__", RenderList(store.List(uid, "pending"), "pending", store.Count(uid)))
	}))

	// Tab switch. A GET, and deliberately read-only: a GET is a CORS-simple
	// request, so anything that mutates must not be reachable by one.
	mux.HandleFunc("GET /testimonials", requireUser(store, func(w http.ResponseWriter, r *http.Request, uid string) {
		in := readSignals(r)
		if s, ok := newSSE(w); ok {
			redraw(s, uid, in.Tab)
		}
	}))

	// Add by hand. Validation failures patch the message region and stop —
	// no redirect, no page reload, no lost form state.
	mux.HandleFunc("POST /testimonials", requireUser(store, func(w http.ResponseWriter, r *http.Request, uid string) {
		in := readSignals(r)
		s, ok := newSSE(w)
		if !ok {
			return
		}
		row, bad := ValidateManual(in.ManualInput)
		if bad != nil {
			s.patch(RenderMsg("err", esc(bad.Message)))
			return
		}
		switch err := store.Insert(uid, newID(), row); {
		case err == ErrDuplicate:
			s.patch(RenderMsg("err", "You have already added that one."))
			return
		case err != nil:
			s.patch(RenderMsg("err", "Could not save that. Try again."))
			return
		}
		s.patch(RenderMsg("ok", "Added. It is waiting in <strong>Pending</strong> for you to approve."))
		s.signals(`{content: '', authorName: '', authorHandle: '', sourceUrl: '', postedAt: '', tab: 'pending'}`)
		redraw(s, uid, "pending")
	}))

	mux.HandleFunc("PATCH /testimonials/{id}", requireUser(store, func(w http.ResponseWriter, r *http.Request, uid string) {
		in := readSignals(r)
		status := r.URL.Query().Get("status")
		if status != "approved" && status != "dismissed" {
			http.Error(w, `status must be "approved" or "dismissed"`, 400)
			return
		}
		if !store.SetStatus(uid, r.PathValue("id"), status) {
			http.Error(w, "not found", 404)
			return
		}
		if s, ok := newSSE(w); ok {
			redraw(s, uid, in.Tab)
		}
	}))

	mux.HandleFunc("DELETE /testimonials/{id}", requireUser(store, func(w http.ResponseWriter, r *http.Request, uid string) {
		in := readSignals(r)
		if !store.Delete(uid, r.PathValue("id")) {
			http.Error(w, "not found", 404)
			return
		}
		if s, ok := newSSE(w); ok {
			redraw(s, uid, in.Tab)
		}
	}))

	log.Printf("social-proof (Datastar/Go) on http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}

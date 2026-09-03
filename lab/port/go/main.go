package main

// Datastar port of the social-proof dashboard. Go 1.22+ stdlib routing,
// SQLite for storage, SSE for every update. No framework, no build step.
//
// Auth is out of scope for the lab: every request is the same demo user, and
// the ownership checks in store.go are written as if it were real.

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

const userID = "demo-user"

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

// One `data: elements ` line per line of HTML — required by the spec. A single
// missing prefix makes the patch silently do nothing.
func (s *sse) patch(elems string) {
	var b strings.Builder
	b.WriteString("event: datastar-patch-elements\n")
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
	Seed(store)

	// Redraw the three regions a mutation can affect. Targeted patches, not a
	// whole-page replace: Datastar morphs each by id.
	redraw := func(s *sse, tab string) {
		c := store.Counts(userID)
		s.patch(RenderStats(c))
		s.patch(RenderTabs(c, tab))
		s.patch(RenderList(store.List(userID, tab), tab, store.Count(userID)))
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		tpl, err := os.ReadFile(shared + "/dashboard.html")
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		c := store.Counts(userID)
		page := strings.ReplaceAll(string(tpl), "__BACKEND__", "Go")
		page = strings.Replace(page, "__STATS__", RenderStats(c), 1)
		page = strings.Replace(page, "__TABS__", RenderTabs(c, "pending"), 1)
		page = strings.Replace(page, "__LIST__",
			RenderList(store.List(userID, "pending"), "pending", store.Count(userID)), 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, page)
	})

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

	// Tab switch.
	mux.HandleFunc("GET /testimonials", func(w http.ResponseWriter, r *http.Request) {
		in := readSignals(r)
		if s, ok := newSSE(w); ok {
			redraw(s, in.Tab)
		}
	})

	// Add by hand. Validation failures patch the message region and stop —
	// no redirect, no page reload, no lost form state.
	mux.HandleFunc("POST /testimonials", func(w http.ResponseWriter, r *http.Request) {
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
		switch err := store.Insert(userID, newID(), row); {
		case err == ErrDuplicate:
			s.patch(RenderMsg("err", "You have already added that one."))
			return
		case err != nil:
			s.patch(RenderMsg("err", "Could not save that. Try again."))
			return
		}
		s.patch(RenderMsg("ok", "Added. It is waiting in <strong>Pending</strong> for you to approve."))
		s.signals(`{content: '', authorName: '', authorHandle: '', sourceUrl: '', postedAt: '', tab: 'pending'}`)
		redraw(s, "pending")
	})

	mux.HandleFunc("PATCH /testimonials/{id}", func(w http.ResponseWriter, r *http.Request) {
		in := readSignals(r)
		status := r.URL.Query().Get("status")
		if status != "approved" && status != "dismissed" {
			http.Error(w, `status must be "approved" or "dismissed"`, 400)
			return
		}
		if !store.SetStatus(userID, r.PathValue("id"), status) {
			http.Error(w, "not found", 404)
			return
		}
		if s, ok := newSSE(w); ok {
			redraw(s, in.Tab)
		}
	})

	mux.HandleFunc("DELETE /testimonials/{id}", func(w http.ResponseWriter, r *http.Request) {
		in := readSignals(r)
		if !store.Delete(userID, r.PathValue("id")) {
			http.Error(w, "not found", 404)
			return
		}
		if s, ok := newSSE(w); ok {
			redraw(s, in.Tab)
		}
	})

	log.Printf("social-proof (Datastar/Go) on http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}

// Datastar lab — Go backend. Standard library only: no framework, no deps.
package main

import (
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type item struct {
	ID       int
	Author   string
	Text     string
	Approved bool
}

var (
	mu    sync.Mutex
	items = []item{
		{1, "Ada Lovelace", "Shipped in an afternoon. No build step at all.", true},
		{2, "Grace Hopper", "The SSE patching is the whole trick.", false},
		{3, "Alan Turing", "One file. I keep waiting for the catch.", false},
	}
	nextID = 4
)

// ---------- SSE ----------

type sse struct {
	w http.ResponseWriter
	f http.Flusher
}

func newSSE(w http.ResponseWriter) (*sse, bool) {
	f, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return nil, false
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	f.Flush()
	return &sse{w, f}, true
}

// patchElements emits one `data: elements ` line per line of HTML — required by the spec.
func (s *sse) patchElements(elems string, opts ...string) {
	var b strings.Builder
	b.WriteString("event: datastar-patch-elements\n")
	for _, o := range opts {
		b.WriteString("data: " + o + "\n")
	}
	for _, line := range strings.Split(strings.TrimRight(elems, "\n"), "\n") {
		b.WriteString("data: elements " + line + "\n")
	}
	b.WriteString("\n")
	fmt.Fprint(s.w, b.String())
	s.f.Flush()
}

func (s *sse) patchSignals(j string) {
	fmt.Fprintf(s.w, "event: datastar-patch-signals\ndata: signals %s\n\n", j)
	s.f.Flush()
}

// ---------- signals in ----------

type signals struct {
	Query  string `json:"query"`
	Author string `json:"author"`
	Text   string `json:"text"`
}

func readSignals(r *http.Request) signals {
	var s signals
	raw := r.URL.Query().Get("datastar") // GET: signals ride in a query param
	if raw == "" && r.Body != nil {
		b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // other verbs: JSON body
		raw = string(b)
	}
	if raw != "" {
		_ = json.Unmarshal([]byte(raw), &s)
	}
	return s
}

// ---------- rendering ----------

func renderList(query string) string {
	mu.Lock()
	defer mu.Unlock()
	q := strings.ToLower(strings.TrimSpace(query))

	var b strings.Builder
	b.WriteString(`<div id="list">`)
	shown := 0
	for _, it := range items {
		if q != "" && !strings.Contains(strings.ToLower(it.Author+" "+it.Text), q) {
			continue
		}
		shown++
		cls := "item"
		if it.Approved {
			cls += " ok"
		}
		b.WriteString(fmt.Sprintf(
			`<div class="%s"><div class="grow"><div class="who">%s</div><div class="txt">%s</div></div>`+
				`<button title="Approve" data-on:click="@post('/items/toggle?id=%d')">&check;</button>`+
				`<button title="Delete" data-on:click="@delete('/items?id=%d')">&times;</button></div>`,
			cls, html.EscapeString(it.Author), html.EscapeString(it.Text), it.ID, it.ID))
	}
	if shown == 0 {
		b.WriteString(`<p class="mut">Nothing matches.</p>`)
	}
	b.WriteString(`</div>`)
	return b.String()
}

// ---------- handlers ----------

func main() {
	shared := os.Getenv("LAB_SHARED")
	if shared == "" {
		shared = "../shared/index.html"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		tpl, err := os.ReadFile(shared) // re-read per request: edit HTML, hit refresh
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		page := strings.ReplaceAll(string(tpl), "__BACKEND__", "Go "+strings.TrimPrefix(runtime.Version(), "go"))
		page = strings.Replace(page, "__LIST__", renderList(""), 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, page)
	})

	http.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })

	http.HandleFunc("/datastar.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		http.ServeFile(w, r, strings.Replace(shared, "index.html", "datastar.js", 1))
	})

	http.HandleFunc("/search", func(w http.ResponseWriter, r *http.Request) {
		sig := readSignals(r)
		s, ok := newSSE(w)
		if !ok {
			return
		}
		s.patchElements(renderList(sig.Query))
	})

	http.HandleFunc("/items", func(w http.ResponseWriter, r *http.Request) {
		sig := readSignals(r)
		switch r.Method {
		case http.MethodPost:
			a, t := strings.TrimSpace(sig.Author), strings.TrimSpace(sig.Text)
			if a != "" && t != "" {
				mu.Lock()
				items = append([]item{{nextID, a, t, false}}, items...)
				nextID++
				mu.Unlock()
			}
		case http.MethodDelete:
			id, _ := strconv.Atoi(r.URL.Query().Get("id"))
			mu.Lock()
			out := items[:0]
			for _, it := range items {
				if it.ID != id {
					out = append(out, it)
				}
			}
			items = out
			mu.Unlock()
		default:
			http.Error(w, "method not allowed", 405)
			return
		}
		s, ok := newSSE(w)
		if !ok {
			return
		}
		s.patchElements(renderList(sig.Query))
		if r.Method == http.MethodPost {
			s.patchSignals(`{author: '', text: ''}`) // clear the form
		}
	})

	http.HandleFunc("/items/toggle", func(w http.ResponseWriter, r *http.Request) {
		sig := readSignals(r)
		id, _ := strconv.Atoi(r.URL.Query().Get("id"))
		mu.Lock()
		for i := range items {
			if items[i].ID == id {
				items[i].Approved = !items[i].Approved
			}
		}
		mu.Unlock()
		if s, ok := newSSE(w); ok {
			s.patchElements(renderList(sig.Query))
		}
	})

	// One request, many patches over time — the thing that needs a websocket + store elsewhere.
	http.HandleFunc("/import", func(w http.ResponseWriter, r *http.Request) {
		s, ok := newSSE(w)
		if !ok {
			return
		}
		s.patchSignals(`{importing: true}`)
		const steps = 8
		for i := 1; i <= steps; i++ {
			select {
			case <-r.Context().Done():
				return // browser navigated away; stop work
			case <-time.After(320 * time.Millisecond):
			}
			pct := i * 100 / steps
			s.patchElements(fmt.Sprintf(
				`<div id="progress" class="mut">Importing batch %d of %d&hellip;<div class="bar"><i style="width:%d%%"></i></div></div>`,
				i, steps, pct))
		}
		mu.Lock()
		items = append([]item{{nextID, "Imported batch", "Arrived over a single streaming response.", true}}, items...)
		nextID++
		mu.Unlock()
		s.patchElements(`<div id="progress" class="mut">Done — one HTTP request, 9 DOM patches.</div>`)
		s.patchElements(renderList(""))
		s.patchSignals(`{importing: false}`)
	})

	log.Printf("Go backend on http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

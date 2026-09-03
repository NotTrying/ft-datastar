package main

import "time"

// Sample rows so the dashboard has something to show. Mirrors the mock X data
// the SvelteKit app ships in src/lib/server/sources/x.ts.
// SeedAccount creates the demo login and returns its user id.
func SeedAccount(s *Store) string {
	if id, ok := s.UserID("owner@example.com"); ok {
		return id
	}
	id, err := s.CreateUser("owner@example.com", "correct-horse-battery")
	if err != nil {
		panic(err)
	}
	// Pro so the handle and testimonial caps are exercised but not in the way.
	_, _ = s.db.Exec(`UPDATE app_user SET plan = 'pro' WHERE id = ?`, id)
	_ = s.AddHandle(id, "acmetools")
	return id
}

func Seed(s *Store, userID string) {
	if s.Count(userID) > 0 {
		return
	}
	d := func(y int, m time.Month, day int) *time.Time {
		t := time.Date(y, m, day, 12, 0, 0, 0, time.UTC)
		return &t
	}
	rows := []struct {
		row    Row
		status string
	}{
		{Row{"scan", "x", "https://x.com/janes/status/1", "https://x.com/janes/status/1",
			"janesmith", "Jane Smith", "Sold our house in nine days and answered the phone every time.", d(2026, 7, 14)}, "pending"},
		{Row{"scan", "x", "https://x.com/dmr/status/2", "https://x.com/dmr/status/2",
			"dmreid", "Danielle Reid", "Booked them twice now. Turned up when they said they would, which is the whole job.", d(2026, 7, 2)}, "pending"},
		{Row{"manual", "google", "https://g.page/r/demo/review/3", "https://g.page/r/demo/review/3",
			"", "Marcus Bell", "Quoted honestly, finished early, cleaned up after themselves.", d(2026, 6, 21)}, "approved"},
		{Row{"manual", "trustpilot", "https://trustpilot.com/reviews/4", "https://trustpilot.com/reviews/4",
			"", "Priya N.", "Third time using them. No notes.", d(2026, 5, 30)}, "approved"},
		{Row{"scan", "x", "https://x.com/spam/status/5", "https://x.com/spam/status/5",
			"linkfarm22", "", "check out my crypto course link in bio", d(2026, 6, 1)}, "dismissed"},
	}
	for _, r := range rows {
		row := r.row
		if err := s.Insert(userID, newID(), &row); err == nil && r.status != "pending" {
			// Seeded rows land as pending like real ones, then get moved.
			for _, t := range s.List(userID, "pending") {
				if t.PostURL == row.PostURL {
					s.SetStatus(userID, t.ID, r.status)
				}
			}
		}
	}
}

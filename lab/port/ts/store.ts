// SQLite store. Mirrors the shape of the D1 `testimonial` table the SvelteKit
// app uses, including the unique index the dedupe check leans on.
// `bun:sqlite` is built into the runtime — no dependency.
import { Database } from "bun:sqlite";
import type { ManualTestimonialRow } from "./validate.ts";

export type Testimonial = {
  id: string; source: string; platform: string; post_url: string;
  author_handle: string | null; author_name: string | null;
  content: string; status: Status; posted_at: number | null; created_at: number;
};
export type Status = "pending" | "approved" | "dismissed";
export const STATUSES: Status[] = ["pending", "approved", "dismissed"];

export class Duplicate extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS testimonial (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  source        TEXT NOT NULL,
  platform      TEXT NOT NULL,
  post_id       TEXT NOT NULL,
  post_url      TEXT NOT NULL,
  author_handle TEXT,
  author_name   TEXT,
  content       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','dismissed')),
  posted_at     INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS testimonial_dedupe
  ON testimonial (user_id, platform, post_id);
`;

export class Store {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(SCHEMA);
  }

  counts(userId: string): Record<Status, number> {
    const out = { pending: 0, approved: 0, dismissed: 0 } as Record<Status, number>;
    const rows = this.db.query<{ status: Status; n: number }, [string]>(
      `SELECT status, count(*) AS n FROM testimonial WHERE user_id = ? GROUP BY status`,
    ).all(userId);
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  total(userId: string): number {
    return this.db.query<{ n: number }, [string]>(
      `SELECT count(*) AS n FROM testimonial WHERE user_id = ?`).get(userId)!.n;
  }

  list(userId: string, status: Status): Testimonial[] {
    return this.db.query<Testimonial, [string, string]>(`
      SELECT id, source, platform, post_url, author_handle, author_name,
             content, status, posted_at, created_at
        FROM testimonial WHERE user_id = ? AND status = ?
       ORDER BY created_at DESC`).all(userId, status);
  }

  insert(userId: string, id: string, r: ManualTestimonialRow, status: Status = "pending") {
    try {
      this.db.query(`
        INSERT INTO testimonial (id, user_id, source, platform, post_id, post_url,
                                 author_handle, author_name, content, status, posted_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, userId, r.source, r.platform, r.postId, r.postUrl,
        r.authorHandle, r.authorName, r.content, status,
        r.postedAt ? r.postedAt.getTime() : null, Date.now());
    } catch (e) {
      if (String(e).toUpperCase().includes("UNIQUE")) throw new Duplicate();
      throw e;
    }
  }

  // Scoped by user_id as well as id: ownership is enforced in the WHERE
  // clause, not in a check above it.
  setStatus(userId: string, id: string, status: Status): boolean {
    return this.db.query(`UPDATE testimonial SET status = ? WHERE id = ? AND user_id = ?`)
      .run(status, id, userId).changes > 0;
  }

  remove(userId: string, id: string): boolean {
    return this.db.query(`DELETE FROM testimonial WHERE id = ? AND user_id = ?`)
      .run(id, userId).changes > 0;
  }
}

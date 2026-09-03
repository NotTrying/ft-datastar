// SQLite store. Mirrors the shape of the D1 `testimonial` table the SvelteKit
// app uses, including the unique index the dedupe check leans on.
// `bun:sqlite` is built into the runtime — no dependency.
import { Database } from "bun:sqlite";
import type { ManualTestimonialRow } from "./validate.ts";
import type { Mention } from "./scan.ts";

export type Testimonial = {
  id: string; source: string; platform: string; post_url: string;
  author_handle: string | null; author_name: string | null;
  content: string; status: Status; posted_at: number | null; created_at: number;
};
export type Status = "pending" | "approved" | "dismissed";
export const STATUSES: Status[] = ["pending", "approved", "dismissed"];

export type HandleRow = {
  id: string; platform: string; handle: string;
  last_scanned_at: number | null; last_post_id: string | null;
  pending: number; approved: number;
};

export class Duplicate extends Error {}

const SCHEMA = `
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
  posted_at     INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS testimonial_dedupe
  ON testimonial (user_id, platform, post_id);

CREATE TABLE IF NOT EXISTS app_user (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  pw_hash    TEXT NOT NULL,
  plan       TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

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

  // ---- accounts and sessions ----
  // Password hashing is async and lives in auth.ts; the store only ever sees
  // an already-hashed value.

  createUser(id: string, email: string, pwHash: string) {
    this.db.query(`INSERT INTO app_user (id, email, pw_hash, created_at) VALUES (?,?,?,?)`)
      .run(id, email.trim().toLowerCase(), pwHash, Date.now());
  }

  findUser(email: string): { id: string; pw_hash: string } | null {
    return this.db.query<{ id: string; pw_hash: string }, [string]>(
      `SELECT id, pw_hash FROM app_user WHERE email = ?`).get(email.trim().toLowerCase());
  }

  emailFor(userId: string): string {
    return this.db.query<{ email: string }, [string]>(
      `SELECT email FROM app_user WHERE id = ?`).get(userId)?.email ?? "";
  }

  createSession(tokenHash: string, userId: string, expires: Date) {
    this.db.query(`INSERT INTO session (token_hash, user_id, expires_at) VALUES (?,?,?)`)
      .run(tokenHash, userId, expires.getTime());
  }

  userForToken(tokenHash: string): string | null {
    const row = this.db.query<{ user_id: string; expires_at: number }, [string]>(
      `SELECT user_id, expires_at FROM session WHERE token_hash = ?`).get(tokenHash);
    if (!row) return null;
    if (Date.now() > row.expires_at) { this.dropSession(tokenHash); return null; }
    return row.user_id;
  }

  dropSession(tokenHash: string) {
    this.db.query(`DELETE FROM session WHERE token_hash = ?`).run(tokenHash);
  }

  setPlan(userId: string, plan: string) {
    this.db.query(`UPDATE app_user SET plan = ? WHERE id = ?`).run(plan, userId);
  }

  // ---- monitored handles ----

  planFor(userId: string): string {
    return this.db.query<{ plan: string }, [string]>(
      `SELECT plan FROM app_user WHERE id = ?`).get(userId)?.plan ?? "free";
  }

  countHandles(userId: string): number {
    return this.db.query<{ n: number }, [string]>(
      `SELECT count(*) AS n FROM monitored_handle WHERE user_id = ?`).get(userId)!.n;
  }

  addHandle(userId: string, handle: string) {
    try {
      this.db.query(
        `INSERT INTO monitored_handle (id, user_id, platform, handle, created_at) VALUES (?,?,?,?,?)`)
        .run(crypto.randomUUID(), userId, "x", handle, Date.now());
    } catch (e) {
      if (String(e).toUpperCase().includes("UNIQUE")) throw new Duplicate();
      throw e;
    }
  }

  listHandles(userId: string): HandleRow[] {
    return this.db.query<HandleRow, [string]>(`
      SELECT h.id, h.platform, h.handle, h.last_scanned_at, h.last_post_id,
             (SELECT count(*) FROM testimonial t WHERE t.handle_id = h.id AND t.status='pending')  AS pending,
             (SELECT count(*) FROM testimonial t WHERE t.handle_id = h.id AND t.status='approved') AS approved
        FROM monitored_handle h WHERE h.user_id = ? ORDER BY h.created_at`).all(userId);
  }

  handleById(userId: string, id: string): HandleRow | null {
    return this.listHandles(userId).find((h) => h.id === id) ?? null;
  }

  deleteHandle(userId: string, id: string): boolean {
    // Testimonials cascade in the original via FK; done explicitly here.
    this.db.query(`DELETE FROM testimonial WHERE handle_id = ? AND user_id = ?`).run(id, userId);
    return this.db.query(`DELETE FROM monitored_handle WHERE id = ? AND user_id = ?`)
      .run(id, userId).changes > 0;
  }

  touchHandle(id: string, lastPostId: string) {
    this.db.query(`UPDATE monitored_handle SET last_scanned_at = ?, last_post_id = ? WHERE id = ?`)
      .run(Date.now(), lastPostId, id);
  }

  logScan(userId: string, handleId: string) {
    this.db.query(`INSERT INTO scan_log (id, user_id, handle_id, at) VALUES (?,?,?,?)`)
      .run(crypto.randomUUID(), userId, handleId, Date.now());
  }

  scansThisMonth(userId: string): number {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
    return this.db.query<{ n: number }, [string, number]>(
      `SELECT count(*) AS n FROM scan_log WHERE user_id = ? AND at >= ?`).get(userId, d.getTime())!.n;
  }

  knownPostIds(userId: string, platform: string): Set<string> {
    return new Set(this.db.query<{ post_id: string }, [string, string]>(
      `SELECT post_id FROM testimonial WHERE user_id = ? AND platform = ?`)
      .all(userId, platform).map((r) => r.post_id));
  }

  insertScanned(userId: string, handleId: string, m: Mention) {
    try {
      this.db.query(`
        INSERT INTO testimonial (id, user_id, handle_id, source, platform, post_id, post_url,
                                 author_handle, author_name, content, status, posted_at, created_at)
        VALUES (?,?,?,'scan',?,?,?,?,?,?,'pending',?,?)`).run(
        crypto.randomUUID(), userId, handleId, m.platform, m.postId, m.postUrl,
        m.authorHandle, m.authorName, m.content, m.postedAt.getTime(), Date.now());
    } catch (e) {
      if (String(e).toUpperCase().includes("UNIQUE")) throw new Duplicate();
      throw e;
    }
  }

  remove(userId: string, id: string): boolean {
    return this.db.query(`DELETE FROM testimonial WHERE id = ? AND user_id = ?`)
      .run(id, userId).changes > 0;
  }
}

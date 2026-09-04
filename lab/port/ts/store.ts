// SQLite store. Mirrors the shape of the D1 `testimonial` table the SvelteKit
// app uses, including the unique index the dedupe check leans on.
// The database comes from the runtime seam rather than an import: on Bun it is
// the built-in `bun:sqlite` (no dependency), on Workers a Durable Object's
// SQLite storage, whose API is likewise synchronous. See runtime.ts.
import { rt, type SqliteLike } from "./runtime.ts";
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

export type WallRow = {
  id: string; name: string; enabled: number; layout: string; theme: string;
  density: string; show_dates: number; max_items: number;
  allowed_domains: string | null; css_vars: string | null;
};
export type WallItemRow = {
  id: string; platform: string; content: string; post_url: string;
  author_handle: string | null; author_name: string | null;
  author_avatar: string | null; posted_at: number | null;
};

export type AdminUserRow = {
  id: string; email: string; name: string | null; role: string; plan: string;
  banned: number; ban_reason: string | null; ban_expires: number | null; created_at: number;
};

export type SessionRow = {
  token_hash: string; created_at: number; expires_at: number; user_agent: string | null;
};

export type OrgRow = { id: string; name: string; slug: string; created_at: number };
export type MemberRow = {
  id: string; user_id: string; role: string; created_at: number;
  email: string; name: string | null;
};
export type InviteRow = {
  id: string; organization_id: string; email: string; role: string;
  status: string; expires_at: number; org_name: string;
};

export class Duplicate extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS testimonial (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  handle_id     TEXT,
  source        TEXT NOT NULL,
  platform      TEXT NOT NULL,
  post_id       TEXT NOT NULL,
  post_url      TEXT NOT NULL,
  author_handle TEXT,
  author_name   TEXT,
  author_avatar TEXT,
  content       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','dismissed')),
  verify_state  TEXT NOT NULL DEFAULT 'unknown',
  last_verified_at INTEGER,
  posted_at     INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS testimonial_dedupe
  ON testimonial (org_id, platform, post_id);

CREATE TABLE IF NOT EXISTS app_user (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT,
  pw_hash    TEXT NOT NULL,
  plan       TEXT NOT NULL DEFAULT 'free',
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  banned     INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT,
  ban_expires INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT,
  active_org_id TEXT
);

CREATE TABLE IF NOT EXISTS monitored_handle (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  platform        TEXT NOT NULL,
  handle          TEXT NOT NULL,
  last_scanned_at INTEGER,
  last_post_id    TEXT,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS handle_dedupe
  ON monitored_handle (org_id, platform, handle);

-- The original counts testimonials created this month against scansPerMonth.
-- That under-counts scans that find nothing and over-counts manual additions,
-- so this port logs scans properly. See README-SCAN.md.
CREATE TABLE IF NOT EXISTS scan_log (
  id        TEXT PRIMARY KEY,
  org_id    TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  handle_id TEXT NOT NULL,
  at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS organization (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS member (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  role            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS member_unique ON member (organization_id, user_id);

CREATE TABLE IF NOT EXISTS invitation (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL,
  status          TEXT NOT NULL,
  inviter_id      TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wall (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
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
`;

// Every ORDER BY below carries `id` as a final tiebreaker, and that is
// load-bearing rather than tidy. Ordering on a timestamp alone is only a total
// order if no two rows share one — true on Bun, where Date.now() advances
// between inserts, and false on Cloudflare Workers, which freezes the clock
// within a request so everything written by one request shares a timestamp
// exactly. SQLite is then free to return tied rows in any order, and does:
// the same query returned a different first row on consecutive calls, which is
// how this was found. A total order costs nothing and removes the class.
export class Store {
  private db: SqliteLike;
  constructor(path: string) {
    this.db = rt().openDatabase(path);
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(SCHEMA);
  }

  counts(userId: string): Record<Status, number> {
    const out = { pending: 0, approved: 0, dismissed: 0 } as Record<Status, number>;
    const rows = this.db.query<{ status: Status; n: number }, [string]>(
      `SELECT status, count(*) AS n FROM testimonial WHERE org_id = ? GROUP BY status`,
    ).all(userId);
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  total(userId: string): number {
    return this.db.query<{ n: number }, [string]>(
      `SELECT count(*) AS n FROM testimonial WHERE org_id = ?`).get(userId)!.n;
  }

  list(userId: string, status: Status): Testimonial[] {
    return this.db.query<Testimonial, [string, string]>(`
      SELECT id, source, platform, post_url, author_handle, author_name,
             content, status, posted_at, created_at
        FROM testimonial WHERE org_id = ? AND status = ?
       ORDER BY created_at DESC, id DESC`).all(userId, status);
  }

  insert(orgId: string, userId: string, id: string, r: ManualTestimonialRow, status: Status = "pending") {
    try {
      this.db.query(`
        INSERT INTO testimonial (id, org_id, user_id, source, platform, post_id, post_url,
                                 author_handle, author_name, content, status, posted_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, orgId, userId, r.source, r.platform, r.postId, r.postUrl,
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
    return this.db.query(`UPDATE testimonial SET status = ? WHERE id = ? AND org_id = ?`)
      .run(status, id, userId).changes > 0;
  }

  // ---- accounts and sessions ----
  // Password hashing is async and lives in auth.ts; the store only ever sees
  // an already-hashed value.

  createUser(id: string, email: string, pwHash: string, name = "") {
    this.db.query(`INSERT INTO app_user (id, email, name, pw_hash, created_at) VALUES (?,?,?,?,?)`)
      .run(id, email.trim().toLowerCase(), name || null, pwHash, Date.now());
  }

  findUser(email: string): { id: string; pw_hash: string } | null {
    return this.db.query<{ id: string; pw_hash: string }, [string]>(
      `SELECT id, pw_hash FROM app_user WHERE email = ?`).get(email.trim().toLowerCase());
  }

  emailFor(userId: string): string {
    return this.db.query<{ email: string }, [string]>(
      `SELECT email FROM app_user WHERE id = ?`).get(userId)?.email ?? "";
  }

  createSession(tokenHash: string, userId: string, expires: Date, userAgent = "") {
    this.db.query(`INSERT INTO session (token_hash, user_id, expires_at, created_at, user_agent)
                   VALUES (?,?,?,?,?)`)
      .run(tokenHash, userId, expires.getTime(), Date.now(), userAgent || null);
  }

  // ---- profile + sessions ----

  userById(id: string): AdminUserRow | null {
    return this.db.query<AdminUserRow, [string]>(
      `SELECT id, email, name, role, plan, banned, ban_reason, ban_expires, created_at
         FROM app_user WHERE id = ?`).get(id);
  }

  /**
   * The least-recently-verified approved rows that are worth re-checking.
   * NULLs sort first in SQLite, so never-checked rows come before merely-stale
   * ones. Rows already marked `gone` are never selected.
   */
  dueForVerification(orgId: string | null, limit: number, cutoff: number):
    { id: string; platform: string; post_url: string }[] {
    const where = orgId ? "AND org_id = ?" : "";
    const params: (string | number)[] = orgId ? [orgId, cutoff, limit] : [cutoff, limit];
    return this.db.query<{ id: string; platform: string; post_url: string }, any>(`
      SELECT id, platform, post_url FROM testimonial
       WHERE status = 'approved' AND verify_state != 'gone' ${where}
         AND (last_verified_at IS NULL OR last_verified_at < ?)
       ORDER BY last_verified_at ASC, id ASC LIMIT ?`).all(...params);
  }

  setPostUrl(id: string, postUrl: string, platform?: string) {
    this.db.query(`UPDATE testimonial SET post_url = ?, post_id = ?, platform = coalesce(?, platform) WHERE id = ?`)
      .run(postUrl, postUrl, platform ?? null, id);
  }

  /** Test scaffolding only: parks every other approved row so a sweep with
   *  limit 1 is guaranteed to pick the row under test. The sweep orders by
   *  last_verified_at ASC, which is not the same order as the dashboard's. */
  parkOthers(orgId: string, keepId: string, at: number) {
    this.db.query(`UPDATE testimonial SET last_verified_at = ?
                    WHERE org_id = ? AND id != ? AND status = 'approved'`).run(at, orgId, keepId);
  }

  setVerifyState(id: string, state: string, at: number) {
    this.db.query(`UPDATE testimonial SET verify_state = ?, last_verified_at = ? WHERE id = ?`)
      .run(state, at, id);
  }

  verifyStateOf(id: string): { verify_state: string; last_verified_at: number | null } | null {
    return this.db.query<{ verify_state: string; last_verified_at: number | null }, [string]>(
      `SELECT verify_state, last_verified_at FROM testimonial WHERE id = ?`).get(id);
  }

  avatarFor(testimonialId: string): string | null {
    return this.db.query<{ author_avatar: string | null }, [string]>(
      `SELECT author_avatar FROM testimonial WHERE id = ?`).get(testimonialId)?.author_avatar ?? null;
  }

  setAvatar(testimonialId: string, url: string | null) {
    this.db.query(`UPDATE testimonial SET author_avatar = ? WHERE id = ?`).run(url, testimonialId);
  }

  // ---- admin ----

  listUsers(): AdminUserRow[] {
    return this.db.query<AdminUserRow, []>(
      `SELECT id, email, name, role, plan, banned, ban_reason, ban_expires, created_at
         FROM app_user ORDER BY created_at DESC, id DESC`).all();
  }

  setRole(id: string, role: "user" | "admin") {
    this.db.query(`UPDATE app_user SET role = ? WHERE id = ?`).run(role, id);
  }

  /**
   * Banning also ends the target's sessions. A bare UPDATE would leave them
   * signed in until their cookie expired, which is the whole point of a ban —
   * the original relies on better-auth's banUser doing the same.
   */
  banUser(id: string, reason: string, expires: number | null): boolean {
    const changed = this.db.query(`UPDATE app_user SET banned = 1, ban_reason = ?, ban_expires = ? WHERE id = ?`)
      .run(reason, expires, id).changes > 0;
    if (changed) this.db.query(`DELETE FROM session WHERE user_id = ?`).run(id);
    return changed;
  }

  unbanUser(id: string): boolean {
    return this.db.query(`UPDATE app_user SET banned = 0, ban_reason = NULL, ban_expires = NULL WHERE id = ?`)
      .run(id).changes > 0;
  }

  /**
   * Delete a user and everything that hangs off them. The original routes this
   * through better-auth's removeUser so the user.delete hook fires (cancelling
   * the org's Stripe subscription); billing is out of scope here, so this does
   * the data half only. Orgs left with no members go too, rather than becoming
   * unreachable rows owning testimonials nobody can see.
   */
  deleteUser(id: string): boolean {
    const orgs = this.orgsFor(id).map((o) => o.id);
    this.db.query(`DELETE FROM session WHERE user_id = ?`).run(id);
    this.db.query(`DELETE FROM member WHERE user_id = ?`).run(id);
    for (const orgId of orgs) {
      const left = this.db.query<{ n: number }, [string]>(
        `SELECT count(*) AS n FROM member WHERE organization_id = ?`).get(orgId)!.n;
      if (left === 0) {
        for (const t of ["testimonial", "monitored_handle", "wall", "scan_log", "invitation"]) {
          const col = t === "invitation" ? "organization_id" : "org_id";
          this.db.query(`DELETE FROM ${t} WHERE ${col} = ?`).run(orgId);
        }
        this.db.query(`DELETE FROM organization WHERE id = ?`).run(orgId);
      }
    }
    return this.db.query(`DELETE FROM app_user WHERE id = ?`).run(id).changes > 0;
  }

  setUserName(id: string, name: string) {
    this.db.query(`UPDATE app_user SET name = ? WHERE id = ?`).run(name, id);
  }

  setUserEmail(id: string, email: string) {
    this.db.query(`UPDATE app_user SET email = ? WHERE id = ?`).run(email.trim().toLowerCase(), id);
  }

  listSessions(userId: string): SessionRow[] {
    return this.db.query<SessionRow, [string, number]>(`
      SELECT token_hash, created_at, expires_at, user_agent
        FROM session WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC, token_hash DESC`).all(userId, Date.now());
  }

  // Revoke is scoped by user_id as well as the hash: one user must never be
  // able to end another's session by guessing a hash.
  revokeSession(userId: string, tokenHash: string): boolean {
    return this.db.query(`DELETE FROM session WHERE token_hash = ? AND user_id = ?`)
      .run(tokenHash, userId).changes > 0;
  }

  revokeOtherSessions(userId: string, keepHash: string): number {
    return this.db.query(`DELETE FROM session WHERE user_id = ? AND token_hash != ?`)
      .run(userId, keepHash).changes;
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

  // ---- organizations ----

  createOrg(id: string, name: string, slug: string) {
    try {
      this.db.query(`INSERT INTO organization (id, name, slug, created_at) VALUES (?,?,?,?)`)
        .run(id, name, slug, Date.now());
    } catch (e) {
      if (String(e).toUpperCase().includes("UNIQUE")) throw new Duplicate();
      throw e;
    }
  }

  deleteOrg(id: string) {
    this.db.query(`DELETE FROM organization WHERE id = ?`).run(id);
  }

  addMember(id: string, orgId: string, userId: string, role: string) {
    try {
      this.db.query(`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?,?,?,?,?)`)
        .run(id, orgId, userId, role, Date.now());
    } catch (e) {
      if (String(e).toUpperCase().includes("UNIQUE")) throw new Duplicate();
      throw e;
    }
  }

  orgsFor(userId: string): OrgRow[] {
    return this.db.query<OrgRow, [string]>(`
      SELECT o.id, o.name, o.slug, o.created_at FROM organization o
        JOIN member m ON m.organization_id = o.id
       WHERE m.user_id = ? ORDER BY o.created_at, o.id`).all(userId);
  }

  org(id: string): OrgRow | null {
    return this.db.query<OrgRow, [string]>(
      `SELECT id, name, slug, created_at FROM organization WHERE id = ?`).get(id);
  }

  members(orgId: string): MemberRow[] {
    return this.db.query<MemberRow, [string]>(`
      SELECT m.id, m.user_id, m.role, m.created_at, u.email, u.name
        FROM member m JOIN app_user u ON u.id = m.user_id
       WHERE m.organization_id = ? ORDER BY m.created_at, m.id`).all(orgId);
  }

  roleIn(orgId: string, userId: string): string | null {
    return this.db.query<{ role: string }, [string, string]>(
      `SELECT role FROM member WHERE organization_id = ? AND user_id = ?`).get(orgId, userId)?.role ?? null;
  }

  removeMember(orgId: string, userId: string): boolean {
    return this.db.query(`DELETE FROM member WHERE organization_id = ? AND user_id = ?`)
      .run(orgId, userId).changes > 0;
  }

  // The active org is a property of the SESSION, matching better-auth.
  setActiveOrg(tokenHash: string, orgId: string | null) {
    this.db.query(`UPDATE session SET active_org_id = ? WHERE token_hash = ?`).run(orgId, tokenHash);
  }

  activeOrg(tokenHash: string): string | null {
    return this.db.query<{ active_org_id: string | null }, [string]>(
      `SELECT active_org_id FROM session WHERE token_hash = ?`).get(tokenHash)?.active_org_id ?? null;
  }

  // ---- invitations ----

  createInvite(id: string, orgId: string, email: string, role: string, inviterId: string, expires: number) {
    this.db.query(`INSERT INTO invitation
      (id, organization_id, email, role, status, inviter_id, expires_at, created_at)
      VALUES (?,?,?,?,'pending',?,?,?)`)
      .run(id, orgId, email.trim().toLowerCase(), role, inviterId, expires, Date.now());
  }

  pendingInvites(orgId: string): InviteRow[] {
    return this.db.query<InviteRow, [string, number]>(`
      SELECT i.id, i.organization_id, i.email, i.role, i.status, i.expires_at, o.name AS org_name
        FROM invitation i JOIN organization o ON o.id = i.organization_id
       WHERE i.organization_id = ? AND i.status = 'pending' AND i.expires_at > ?
       ORDER BY i.created_at DESC, i.id DESC`).all(orgId, Date.now());
  }

  invite(id: string): InviteRow | null {
    return this.db.query<InviteRow, [string]>(`
      SELECT i.id, i.organization_id, i.email, i.role, i.status, i.expires_at, o.name AS org_name
        FROM invitation i JOIN organization o ON o.id = i.organization_id
       WHERE i.id = ?`).get(id);
  }

  inviteByEmail(orgId: string, email: string): InviteRow | null {
    return this.db.query<InviteRow, [string, string, number]>(`
      SELECT i.id, i.organization_id, i.email, i.role, i.status, i.expires_at, o.name AS org_name
        FROM invitation i JOIN organization o ON o.id = i.organization_id
       WHERE i.organization_id = ? AND i.email = ? AND i.status = 'pending' AND i.expires_at > ?`)
      .get(orgId, email.trim().toLowerCase(), Date.now());
  }

  setInviteStatus(id: string, status: string): boolean {
    return this.db.query(`UPDATE invitation SET status = ? WHERE id = ? AND status = 'pending'`)
      .run(status, id).changes > 0;
  }

  // ---- monitored handles ----

  planFor(userId: string): string {
    return this.db.query<{ plan: string }, [string]>(
      `SELECT plan FROM app_user WHERE id = ?`).get(userId)?.plan ?? "free";
  }

  countHandles(userId: string): number {
    return this.db.query<{ n: number }, [string]>(
      `SELECT count(*) AS n FROM monitored_handle WHERE org_id = ?`).get(userId)!.n;
  }

  addHandle(orgId: string, userId: string, handle: string) {
    try {
      this.db.query(
        `INSERT INTO monitored_handle (id, org_id, user_id, platform, handle, created_at) VALUES (?,?,?,?,?,?)`)
        .run(crypto.randomUUID(), orgId, userId, "x", handle, Date.now());
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
        FROM monitored_handle h WHERE h.org_id = ? ORDER BY h.created_at, h.id`).all(userId);
  }

  handleById(userId: string, id: string): HandleRow | null {
    return this.listHandles(userId).find((h) => h.id === id) ?? null;
  }

  deleteHandle(userId: string, id: string): boolean {
    // Testimonials cascade in the original via FK; done explicitly here.
    this.db.query(`DELETE FROM testimonial WHERE handle_id = ? AND org_id = ?`).run(id, userId);
    return this.db.query(`DELETE FROM monitored_handle WHERE id = ? AND org_id = ?`)
      .run(id, userId).changes > 0;
  }

  touchHandle(id: string, lastPostId: string) {
    this.db.query(`UPDATE monitored_handle SET last_scanned_at = ?, last_post_id = ? WHERE id = ?`)
      .run(Date.now(), lastPostId, id);
  }

  logScan(orgId: string, userId: string, handleId: string) {
    this.db.query(`INSERT INTO scan_log (id, org_id, user_id, handle_id, at) VALUES (?,?,?,?,?)`)
      .run(crypto.randomUUID(), orgId, userId, handleId, Date.now());
  }

  scansThisMonth(userId: string): number {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
    return this.db.query<{ n: number }, [string, number]>(
      `SELECT count(*) AS n FROM scan_log WHERE org_id = ? AND at >= ?`).get(userId, d.getTime())!.n;
  }

  knownPostIds(userId: string, platform: string): Set<string> {
    return new Set(this.db.query<{ post_id: string }, [string, string]>(
      `SELECT post_id FROM testimonial WHERE org_id = ? AND platform = ?`)
      .all(userId, platform).map((r) => r.post_id));
  }

  // ---- walls ----
  // Note the asymmetry: dashboard reads are scoped by user_id, the public
  // read (loadWall) is not — the visitor is anonymous.

  createWall(id: string, orgId: string, userId: string, name: string) {
    this.db.query(`INSERT INTO wall (id, org_id, user_id, name, created_at) VALUES (?,?,?,?,?)`)
      .run(id, orgId, userId, name, Date.now());
  }

  listWalls(userId: string): WallRow[] {
    return this.db.query<WallRow, [string]>(
      `SELECT id, name, enabled, layout, theme, density, show_dates, max_items,
              allowed_domains, css_vars FROM wall WHERE org_id = ? ORDER BY created_at, id`).all(userId);
  }

  // A disabled wall is indistinguishable from a missing one.
  loadWall(id: string): { wall: WallRow; orgId: string } | null {
    const row = this.db.query<WallRow & { org_id: string }, [string]>(
      `SELECT id, org_id, name, enabled, layout, theme, density, show_dates, max_items,
              allowed_domains, css_vars FROM wall WHERE id = ?`).get(id);
    if (!row || !row.enabled) return null;
    const { org_id, ...wall } = row;
    return { wall, orgId: org_id };
  }

  setWallEnabled(userId: string, id: string, on: boolean): boolean {
    return this.db.query(`UPDATE wall SET enabled = ? WHERE id = ? AND org_id = ?`)
      .run(on ? 1 : 0, id, userId).changes > 0;
  }

  setWallDomains(userId: string, id: string, domains: string[] | null): boolean {
    return this.db.query(`UPDATE wall SET allowed_domains = ? WHERE id = ? AND org_id = ?`)
      .run(domains === null ? null : JSON.stringify(domains), id, userId).changes > 0;
  }

  deleteWall(userId: string, id: string): boolean {
    return this.db.query(`DELETE FROM wall WHERE id = ? AND org_id = ?`).run(id, userId).changes > 0;
  }

  // Two filters carry the product's whole claim: `approved` (the owner chose
  // it) and verify_state != 'gone' (the original still resolves).
  loadWallItems(orgId: string, max: number): WallItemRow[] {
    return this.db.query<WallItemRow, [string, number]>(`
      SELECT id, platform, content, post_url, author_handle, author_name, author_avatar, posted_at
        FROM testimonial
       WHERE org_id = ? AND status = 'approved' AND coalesce(verify_state,'unknown') != 'gone'
       ORDER BY posted_at DESC, created_at DESC, id DESC LIMIT ?`)
      .all(orgId, Math.max(1, Math.min(max, 100)));
  }

  insertScanned(orgId: string, userId: string, handleId: string, m: Mention) {
    try {
      this.db.query(`
        INSERT INTO testimonial (id, org_id, user_id, handle_id, source, platform, post_id, post_url,
                                 author_handle, author_name, content, status, posted_at, created_at)
        VALUES (?,?,?,?,'scan',?,?,?,?,?,?,'pending',?,?)`).run(
        crypto.randomUUID(), orgId, userId, handleId, m.platform, m.postId, m.postUrl,
        m.authorHandle, m.authorName, m.content, m.postedAt.getTime(), Date.now());
    } catch (e) {
      if (String(e).toUpperCase().includes("UNIQUE")) throw new Duplicate();
      throw e;
    }
  }

  remove(userId: string, id: string): boolean {
    return this.db.query(`DELETE FROM testimonial WHERE id = ? AND org_id = ?`)
      .run(id, userId).changes > 0;
  }
}

// Profile settings. Ported from
// src/routes/(member)/dashboard/settings/+page.server.ts.
//
// The email change is a three-step flow: send an OTP to the CURRENT address to
// prove it is you, then an OTP to the NEW address to prove you own it, then
// commit. The step lives entirely on the server and is pushed as HTML — the
// page holds no step state at all, which is the whole point of the exercise.
//
// NOTE: the original has no self-serve account deletion, deliberately.
// Deletion is admin-only so it runs the `user.delete` databaseHook that cancels
// the org's Stripe subscription; a raw delete would leave a paying org billed
// after the user is gone. That constraint is preserved here.
import { esc } from "./render.ts";
import type { SessionRow } from "./store.ts";

export type Fail = { ok: false; error: string };
export type ProfileInput = { name?: string; email?: string };

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Validation ported message-for-message from the original.
export function validateProfile(
  input: ProfileInput,
): { ok: true; name: string; email: string } | Fail {
  const name = (input.name ?? "").trim();
  if (name.length === 0) return { ok: false, error: "Name is required" };
  if (name.length > 128) return { ok: false, error: "Name must be 128 characters or less" };

  const email = (input.email ?? "").trim().toLowerCase();
  if (!email || !EMAIL_REGEX.test(email)) return { ok: false, error: "Valid email is required" };
  if (email.length > 127) return { ok: false, error: "Email must be 127 characters or less" };

  return { ok: true, name, email };
}

// ---------- OTP ----------

export type OtpStep = "current" | "new";
type Pending = { step: OtpStep; code: string; pendingEmail: string; expires: number };

const OTP_TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, Pending>();

const sixDigits = () => String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");

/**
 * Stand-in for the Cloudflare Email sender the original uses via better-auth's
 * emailOTP plugin. It logs rather than sends. `lastOtp` is exposed ONLY through
 * a route gated on LAB_DEV_OTP=1 so the browser suite can complete the flow;
 * it is never reachable in a normal run.
 */
export let lastOtp: { to: string; code: string } | null = null;

export function issueOtp(userId: string, step: OtpStep, to: string, pendingEmail: string): void {
  const code = sixDigits();
  pending.set(userId, { step, code, pendingEmail, expires: Date.now() + OTP_TTL_MS });
  lastOtp = { to, code };
  console.log(`[email] OTP ${code} -> ${to} (${step})`);
}

export function checkOtp(userId: string, step: OtpStep, code: string): Pending | null {
  const p = pending.get(userId);
  if (!p || p.step !== step || p.code !== code.trim() || Date.now() > p.expires) return null;
  return p;
}

export const clearOtp = (userId: string) => pending.delete(userId);

// ---------- rendering ----------

export const renderMsg = (kind: "" | "ok" | "err", text = "") =>
  kind === "" ? `<div id="settings-msg"></div>`
  : `<div id="settings-msg"><div class="alert ${kind}" role="${kind === "ok" ? "status" : "alert"}">${text}</div></div>`;

/** The profile panel. Which of the three states it renders is the server's call. */
export function renderProfile(
  user: { name: string | null; email: string; plan: string },
  step: OtpStep | null = null,
  pendingEmail = "",
): string {
  if (step === "current" || step === "new") {
    const to = step === "current" ? user.email : pendingEmail;
    const action = step === "current" ? "/settings/verify-current" : "/settings/verify-new";
    return `<div id="profile-panel">
      <p class="muted small">A 6-digit code was sent to <strong>${esc(to)}</strong>.
        ${step === "current"
          ? "Enter it to confirm it is you."
          : "Enter it to complete the change."}</p>
      <form data-on:submit__prevent="@post('${action}')">
        <label class="narrow"><span>Verification code</span>
          <input type="text" inputmode="numeric" maxlength="6" data-bind:otp
                 autocomplete="one-time-code" placeholder="000000"></label>
        <div class="row">
          <button type="submit" class="btn primary" data-attr:disabled="!$otp">Verify</button>
          <button type="button" class="btn" data-on:click="@post('/settings/cancel-email')">Cancel</button>
        </div>
      </form>
    </div>`;
  }

  return `<div id="profile-panel">
    <form data-on:submit__prevent="@post('/settings/profile')" data-indicator:_saving>
      <label><span>Name</span>
        <input type="text" maxlength="128" data-bind:name value="${esc(user.name ?? "")}"></label>
      <label><span>Email</span>
        <input type="email" maxlength="127" data-bind:email value="${esc(user.email)}">
        <span class="hint">Changing this needs a code from your current address first,
          then one from the new address.</span></label>
      <div class="row">
        <button type="submit" class="btn primary" data-attr:disabled="$_saving"
                data-text="$_saving ? 'Saving…' : 'Save changes'">Save changes</button>
        <span class="muted small">Plan: <strong>${esc(user.plan)}</strong></span>
      </div>
    </form>
  </div>`;
}

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

export function renderSessions(sessions: SessionRow[], currentHash: string): string {
  const rows = sessions.map((s) => {
    const isCurrent = s.token_hash === currentHash;
    return `<article class="t session"><div class="who"><div>` +
      `<div class="meta"><span class="name">${esc(s.user_agent || "Unknown device")}</span>` +
      (isCurrent ? `<span class="plat">this device</span>` : "") + `</div>` +
      `<div class="foot"><span>Signed in ${esc(ago(s.created_at))}</span>` +
      `<code class="mono">${esc(s.token_hash.slice(0, 12))}</code></div>` +
      `</div></div><div class="acts">` +
      (isCurrent ? `<span class="muted small">current</span>`
        : `<button class="btn sm danger" data-on:click="@delete('/settings/sessions/${esc(s.token_hash)}')">Revoke</button>`) +
      `</div></article>`;
  }).join("");

  const others = sessions.filter((s) => s.token_hash !== currentHash).length;
  return `<div id="sessions">${rows}` +
    (others > 0
      ? `<div class="row" style="margin-top:12px"><button class="btn danger" ` +
        `data-on:click="@post('/settings/revoke-others')">Sign out ${others} other ` +
        `session${others === 1 ? "" : "s"}</button></div>`
      : "") +
    `</div>`;
}

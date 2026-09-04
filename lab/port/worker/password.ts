// Password hashing for Workers, which has no argon2.
//
// PBKDF2-SHA256 through WebCrypto: not argon2's equal against a GPU, but it is
// what the platform offers without pulling in WASM, and the parameters are
// stated in the stored hash so they can be raised without invalidating it.
// Bun keeps argon2id — see runtime.bun.ts.
const ITERATIONS = 100_000;
const KEY_BITS = 256;

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pw: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    KEY_BITS,
  );
  return b64(bits);
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pw, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt.buffer as ArrayBuffer)}$${hash}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterations || !salt || !hash) return false;
  const candidate = await derive(pw, unb64(salt), Number(iterations));
  // Constant-time: a length-independent compare over the fixed-width base64.
  if (candidate.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

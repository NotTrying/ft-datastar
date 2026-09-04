// Shared better-auth options, with NO database.
//
// Why this file exists: the better-auth CLI runs under Node (via jiti) and
// cannot resolve `bun:sqlite`, so a config importing it fails to load and the
// CLI can neither generate nor migrate the schema. The runtime keeps
// bun:sqlite; the CLI gets node:sqlite. Both must describe the same plugins or
// the generated schema will not match what the server expects.
import { organization } from "better-auth/plugins";

// NOTE: no `as const`. It makes `plugins` a readonly tuple, which does not
// satisfy `BetterAuthPlugin[]`, and better-auth then falls back to the
// pluginless `auth.api` type — every organisation method silently disappears
// from the API surface while the runtime keeps working. `tsc` catches it; a
// bun-only workflow would not.
export const options = {
  baseURL: process.env.LAB_ORIGIN ?? "http://localhost:8095",
  secret: process.env.BETTER_AUTH_SECRET ?? "lab-only-secret-not-for-production-use-0123456789",
  emailAndPassword: {
    enabled: true,
    // No mail sender wired up in the lab.
    requireEmailVerification: false,
  },
  plugins: [organization()],
};

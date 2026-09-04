// Lab seed. Users are created through better-auth's own sign-up API rather
// than by inserting rows: password hashing, the account row and the
// issuer-scoped identity all belong to the library, and reproducing them by
// hand is exactly the drift that broke the CLI-generated schema.
import { auth } from "./auth.ts";

for (const [email, name] of [
  ["owner@example.com", "Owner"],
  ["other@example.com", "Other"],
] as const) {
  try {
    await auth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name } });
    console.log("created", email);
  } catch (e) {
    console.log("exists ", email, String(e).split("\n")[0].slice(0, 80));
  }
}

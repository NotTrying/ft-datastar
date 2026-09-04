// Bun entry point. Installs the Bun runtime, then loads the app — the import
// order matters, because server.ts opens the database and seeds it at module
// scope.
import "./runtime.bun.ts";
export { default } from "./server.ts";

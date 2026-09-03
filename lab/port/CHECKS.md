# What actually checks a Datastar app

I said earlier there was "no end-to-end type safety". That was too loose, so here is the
measured answer.

## What Datastar itself reports

Each mistake below was served on its own page against the v1.0.3 bundle and the console
watched. There is only one bundle — no separate dev build — so this is what production does.

| Mistake | Datastar says | What actually happens |
|---|---|---|
| `data-text:foo` — key where none allowed | **throws `KeyNotAllowed`** + docs link | attribute skipped |
| `data-text="$real +"` — expression syntax error | **throws `SyntaxError` / `GenerateExpression`** | attribute skipped |
| patch aimed at a missing id | **warns `PatchElementsNoTargetsFound`** | patch dropped |
| `data-txet="…"` — misspelled attribute | **nothing** | silently ignored |
| `data-text="$neverDeclared"` — undeclared signal | **nothing** | element **blanked** |
| `data-bind:authorName` — uppercase in the key | **nothing** | binds `$authorname`; your `$authorName` never updates |
| `data-on:click__debownce.300ms` — typo'd modifier | **nothing** | handler runs **without debouncing** |

So Datastar is loud about *malformed* things and silent about *misnamed* ones. Three of the
four silent cases change behaviour without changing appearance — the debounce one would
quietly hammer your server on every keystroke.

It also ships a **VSCode extension and IntelliJ plugin** with `data-*` autocompletion, which
helps while typing but gates nothing in CI.

This is precisely the failure mode `social-proof` already guards against in CSS: per
`CLAUDE.md`, *"Unknown CSS class names are silently ignored by Tailwind and daisyUI, so a
retired class produces no error anywhere"* — which is why `check-daisyui-classes.mjs` and
`check-dead-classes.mjs` exist. Datastar attributes need the same treatment.

## What the rest of the stack covers

| Layer | Covers | Does not cover |
|---|---|---|
| `gofmt` / `go vet` / `go build` | the entire Go backend | anything inside an HTML string |
| `tsc --noEmit` (strict) | the entire TS backend, store, renderers | anything inside a template literal |
| Datastar runtime | malformed attributes and expressions | misnamed anything |
| **`check-datastar.mjs`** | the attribute layer — see below | runtime behaviour |
| **`verify-*.mjs`** | 56 behavioural assertions per backend, in a real browser | code paths not exercised |

The important point: **the server is fully typed and fully checked in both languages.** The
gap is only the HTML attribute layer — perhaps 90 lines of the whole port.

## The guard: `check-datastar.mjs`

Fails the build on the four silent classes plus one more:

1. **Unknown `data-*` attribute** — reported only when it is within edit distance 2 of a real
   one, so the widget's own `data-sp-theme` is correctly ignored while `data-txet` is caught
   with "did you mean `data-text`?"
2. **Unknown modifier** — `__debownce` on any attribute.
3. **Uppercase in an attribute key** — the casing trap, with the kebab-case fix spelled out.
4. **Signal read but never declared** — `$foo` inside a `data-*` value with no
   `data-signals` / `data-bind` / `data-computed` / `data-indicator` / `data-ref` and no
   server `signals()` patch declaring it.
5. **Element-id drift on shared features** — every id the now-frozen Go port renders must
   still be rendered by TypeScript, or a feature they share has drifted apart.

   Note the narrowed scope. This rule was sound while both backends moved in lockstep: an id
   in one and not the other meant somebody was patching an element that would never exist,
   and it caught exactly that. With Go frozen and TypeScript moving ahead, ids that exist
   only in TypeScript are new features, not drift, so the check can no longer flag a renamed
   patch target in new code. **The browser suites catch that instead** — verified by renaming
   `#form-msg` to `#form-msgg` in `render.ts`: `check-datastar.mjs` stays quiet, and
   `verify-port.mjs` fails within seconds waiting for an element that never updates. Static
   analysis narrowed here; runtime coverage took over.

Verified by injecting all five into the real codebase — every one was caught, and reverting
returns it to clean. Both `go vet` and `tsc` stayed silent throughout: none of them are
Go or TypeScript problems.

Two of those rules only exist because writing the checker surfaced its own bugs: the first
version swallowed `__debownce` into the attribute key, and its patch-target rule was vacuous
(the same line both emitted an id and registered it as valid).

## `check.sh` — the whole gate

```
1/6  gofmt
2/6  go vet + build
3/6  tsc --noEmit
4/6  check-datastar
5/6  boot both backends
6/6  browser suites   13 dashboard + 11 auth + 15 scan + 17 embed, per backend
```

**112 assertions, all passing.** The analogue of `pnpm lint && pnpm check && pnpm test:ci`.

## Honest caveats

- **Typechecking costs one dev dependency.** The runtime stays at zero, but `tsc` needs
  `@types/bun`. The "0 dependencies" claim is a runtime claim.
- **`check-datastar.mjs` is hand-maintained**, exactly like `check-daisyui-classes.mjs`. Its
  attribute list is a snapshot of v1.0.3 and will drift on a major upgrade. The
  `check-dead-classes.mjs` trick — diffing against what the built artefact actually
  defines — has no equivalent here, because Datastar's attribute set lives in a minified
  bundle rather than in generated CSS.
- **It is static.** It cannot tell you a `@post` route exists, that a patch will land, or
  that a signal holds the shape you expect. That is what the browser suites are for.
- **`noUncheckedIndexedAccess` is off**, matching `social-proof`'s own tsconfig. Turning it on
  flags `host.split('/')[0]` in the region copied verbatim from your `walls.ts` — safe at
  runtime, and not a defect in your code; just a stricter setting than you run.

## So: is Datastar safe to build on?

For the app behind the login, yes — with the caveat that you write one guard script Datastar
does not give you, and lean harder on browser-level tests than you would with Svelte,
because there is no compiler watching the template. What you lose against SvelteKit is
narrower than "no checks": it is the **compile-time link between template and state**, worth
roughly one 200-line checker plus a habit of asserting behaviour in a browser.

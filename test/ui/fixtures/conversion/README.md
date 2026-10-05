# Currency-conversion browser regressions

These tests mount the real `EntryForm`, `useCurrencyConversion`, `fetchRate`,
conversion resolver and entry math. Only preferences (fixed default USD) and the
FX transport are synthetic. The deferred fake transport intentionally resolves
after abort so stale-request guards are exercised. No account, backend, browser
storage, model, live FX service or private configuration is used.

The eight interaction scenarios cover manual rate and amount overrides during
fetch, changed pairs, disabling/re-enabling, unmount cancellation, failed-fetch
manual fallback, saved conversions and unresolved-conversion save blocking.
A ninth test runs all eight at 390×844 and measures checkbox alignment and form
overflow. Each test requires its exact named checks and nonzero expected count;
an empty result cannot pass.

## Run using the installed dependencies

```sh
pnpm exec playwright test --config=test/ui/conversion.playwright.config.ts
```

Use this dedicated configuration, not the default account-backed UI config.
It starts only an in-memory six-asset loopback fixture on an ephemeral port. It
does not start/reuse the application on port 3000, load `.env`, or proxy APIs.
The fixture applies `connect-src 'none'`; the spec independently rejects every
request except its own local assets. The source graph is checked to contain the
real conversion modules without auth/backend modules.

The repository already depends on Playwright, React and Vite/esbuild. No new
package is required. Use the existing browser installation, or set the existing
`PLAYWRIGHT_EXECUTABLE_PATH` option to an approved local Chromium executable.
Traces, source fingerprints and mobile screenshots go to ignored
`test-results/conversion`.

For an interactive review of exactly the same fixture:

```sh
node test/ui/fixtures/conversion/server.mjs --port 6791
```

Open the printed loopback address. Choose **All eight scenarios**, click
**Run selected tests**, then **Toggle 390px width**. The form remains editable;
the two fake-response buttons can reproduce manual edits during a pending
request. Stop that fixture process when done. The port must be unoccupied.

Preparation/discovery checks without launching a browser or server:

```sh
node test/ui/fixtures/conversion/server.mjs --check
pnpm exec playwright test --config=test/ui/conversion.playwright.config.ts --list
```

## CI status and limitations

The independent `currency-conversion` CI job runs the dedicated command above
using the existing pinned Node/pnpm setup and Chromium installation. It has no
dependency on the original `test` job: a deferred advisory failure there must
not prevent these functional regressions from running. The original job and
its audit gates are unchanged; a conversion pass does not waive their failures.
No backend, Rust build, model download or additional audit is part of this job.

These are synthetic component/browser regressions, not proof of provider
availability, deployed CSP behavior, account persistence or Android rendering.
The migrated fixture's eight scenarios and 390-pixel geometry were checked in
Edge on October 5, 2026. That browser check does not execute the nine Playwright
wrappers or their request/error guards: the exact-commit CI result is required
before claiming those automated tests pass. Preparation and `--list` output
alone are not test execution.

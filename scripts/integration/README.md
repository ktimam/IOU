# OpenChat private handoff contract integration

This optional suite checks IOU's app-owned setup export against a compatible OpenChat checkout's actual catalog parser, extraction runner, per-model prompt selection, conformance rules, final payload projection, and IOU receiver validation. Only local inference/readiness boundaries are mocked. It does **not** establish real model accuracy, WebGPU availability, authentication, or persistence success.

Install each repository's normal dependencies separately before running. The runner never downloads packages, starts servers, or silently skips absent dependencies. Supply both paths explicitly (including a project-specific directory within your chosen temporary storage):

```sh
node scripts/integration/run-openchat-private-handoff.mjs --openchat-checkout /path/to/open-chat-fork --work-dir /path/to/project-temp
```

Five extraction cases cover both model raw-output contracts (Qwen and Gemma), exact receipt amount/date/currency, user-defined Type/direction, date-range notes, and explicit app default currency without restoring source text or guessing a missing date. All fixtures are hand-authored model-output/text data; no user images, account credentials, or private setup catalogs are included.

The additional React lifecycle suite mounts the actual IOU receiver and private-Type hook in the installed jsdom environment. Authenticated actors, key unwrap/decryption and encryption boundaries are mocked; no real account or ledger is accessed. It verifies deferred actor/Type readiness, unavailable account or membership, account-switch cleanup, explicit resolution of mismatched proposed Types, and an outcome-unknown retry using the same reviewed payload and import ID. Deferred key/encryption cases also change actor, identity or successful Type-load generation without changing the principal/sheet, proving the old operation cannot write. A strict-slot case exercises the real slot decoder with only the crypto primitive mocked, distinguishing unreadable from genuinely absent Types. These are deterministic component tests, not real-browser authentication or live-backend proof.

The runner writes only a generated configuration and test cache beneath `--work-dir`, leaves them for diagnosis, and propagates failures as a nonzero exit status. Source paths are derived from the supplied checkout and this script's own location. It uses OpenChat's installed Vitest and current base configuration, so changes to that pipeline are tested rather than reproduced in an IOU mock. The regular IOU unit suite does not need the OpenChat checkout and does not run this DOM/cross-package suite; this explicit integration command is an additional required validation gate whenever either side's private-app contract changes or a local-client release is prepared.

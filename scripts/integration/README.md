# OpenChat private handoff contract integration

This optional suite checks IOU's app-owned setup export against a compatible OpenChat checkout's actual catalog parser, extraction runner, per-model prompt selection, conformance rules, final payload projection, and IOU receiver validation. Only local inference/readiness boundaries are mocked. It does **not** establish real model accuracy, WebGPU availability, authentication, or persistence success.

Install each repository's normal dependencies separately before running. The runner never downloads packages, starts servers, or silently skips absent dependencies. Supply both paths explicitly (including a project-specific directory within your chosen temporary storage):

```sh
node scripts/integration/run-openchat-private-handoff.mjs --openchat-checkout /path/to/open-chat-fork --work-dir /path/to/project-temp
```

Five cases cover both model raw-output contracts (Qwen and Gemma), exact receipt amount/date/currency, user-defined Type/direction, date-range notes, and explicit app default currency without restoring source text or guessing a missing date. All fixtures are hand-authored model-output/text data; no user images, account credentials, or private setup catalogs are included.

The runner writes only a generated configuration and test cache beneath `--work-dir`, leaves them for diagnosis, and propagates failures as a nonzero exit status. Source paths are derived from the supplied checkout and this script's own location. It uses OpenChat's installed Vitest and current base configuration, so changes to that pipeline are tested rather than reproduced in an IOU mock. The regular IOU unit suite does not need the OpenChat checkout; run this explicit integration command whenever either side's private-app contract changes.

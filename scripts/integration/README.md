# OpenChat private handoff contract integration

This additional suite checks IOU's app-owned setup export against a compatible OpenChat checkout's actual catalog parser, extraction runner, per-model prompt selection, conformance rules, final payload projection, sender encryption and IOU receiver decryption. Model inference, authentication and backend actors use explicit test doubles. Actual WebCrypto envelope operations run locally. This does **not** establish real model accuracy, WebGPU availability, account authentication, or live persistence success.

Install each repository's normal dependencies separately before running. The runner never downloads packages, starts servers, or silently skips absent dependencies. Supply both paths explicitly (including a project-specific directory within your chosen temporary storage):

```sh
node scripts/integration/run-openchat-private-handoff.mjs --openchat-checkout /path/to/open-chat-fork --work-dir /path/to/project-temp
```

Synthetic extraction cases cover both model raw-output contracts (Qwen and Gemma), exact receipt amount/date/currency, user-defined Type/direction, date-range notes, and explicit app default currency without restoring source text or guessing a missing date. Four additional cases replay existing, sanitized small-Qwen/Gemma Arabic and date-range outputs verbatim through host parsing, IOU normalization, generic Type initialization, explicit review, real sender encryption and real recipient decryption. The retained outputs are not newly generated inference; historical strict-format failures remain labelled. No user image files, account credentials, or private setup catalogs are included.

The sender/receiver contract suite also decrypts the real separately encrypted ledger payload after an explicitly reviewed mock-backend save. Wrong recipient binding fails, and receipt or decryption alone never calls that write. This verifies local field preservation and encryption interoperability, not the real backend or its key-recovery service.

The additional React lifecycle suite mounts the actual IOU receiver and private-Type hook in the installed jsdom environment. Authenticated actors, delivery-key recovery, Type decryption and ledger encryption use mocks; sender-envelope encryption and recipient decryption use the actual implementation. No real account or ledger is accessed. It verifies deferred actor/Type readiness, unavailable account or membership, account-switch cleanup, explicit resolution of mismatched proposed Types, and an outcome-unknown retry using the same reviewed payload and import ID. Deferred key/encryption cases also change actor, identity or successful Type-load generation without changing the principal/sheet, proving the old operation cannot write. A strict-slot case exercises the real slot decoder with only the crypto primitive mocked, distinguishing unreadable from genuinely absent Types. These are deterministic component tests, not real-browser authentication or live-backend proof.

Two-entry composition cases additionally connect the actual receiver and batch adapter to
OpenChat's actual origin/window/nonce-bound handoff and saved-receipt consumer. A stateful
synthetic actor commits both encrypted rows before losing its first response. Only an
explicit retry reuses the sheet/import identity; its deferred `replayed: true` receipt
returns the original two IDs without adding mock ledger rows. The sender remains
`received` until the receiver emits the complete committed receipt. Fresh synthetic
encrypted envelopes are allowed while both reviewed plaintext rows remain unchanged.
A second-row encryption failure causes no partial batch call or saved receipt. These
tests start from an already-reviewed synthetic request; they do not qualify model
inference, production key recovery, backend atomicity, browser windows, or live replay/save.

Native receiver cases additionally exercise the plain-URL `connect` / user Allow / `connected` bootstrap.
The opener is captured once; the exact canonical localhost origin and public connection ID are frozen
for the user’s decision. No receiver nonce, `ready` acknowledgement or accepted draft exists before
Allow. Tests reject other windows/origins/nonces, expire pending consent after two minutes, and
invalidate approved connections after ten minutes, logout or close. A deferred encryption test proves
that a closed native connection cannot make a late backend write. These mocks do not qualify the
actual Android browser transport or the passkey/account session.

The no-file setup suite mounts the actual `/openchat/connect` page, consent protocol,
private catalog builder and public processor integrity check. Synthetic authentication,
actor reads and the decrypted-Type hook avoid accessing real accounts. It checks explicit
consent before any setup response, exact requester origin/window/nonce binding, selected
account/sheet visibility, and blocked late delivery after authentication, actor, Type-load
generation, destination, expiry or window changes. Public bytes use a real SHA-256 digest.
No processor executes, file downloads, entry writes or credential transfers occur. This
does not qualify browser popup support, real account login or the Android bridge.

The runner writes only a generated configuration and test cache beneath `--work-dir`, leaves them for diagnosis, and propagates failures as a nonzero exit status. Source paths are derived from the supplied checkout and this script's own location. It uses OpenChat's installed Vitest and current base configuration, so changes to that pipeline are tested rather than reproduced in an IOU mock. The regular IOU unit suite does not need the OpenChat checkout and does not run this DOM/cross-package suite; this explicit integration command is an additional required validation gate whenever either side's private-app contract changes or a local-client release is prepared.

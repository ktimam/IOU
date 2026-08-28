# OpenChat image auto-propose — worker staleness & retry notes

Troubleshooting notes for the IOU × OpenChat confirmable-action **image** path, from a 2026-07-14
live investigation driving the real OpenChat desktop app.

## Symptom: the image auto-propose chip never appears (text chips do)

In a chat where IOU is enabled, a keyword message ("iou … due …") shows the **"Propose Add to IOU?"**
chip, but sending a **receipt image** shows no chip — even though IOU's manifest registers
`accepts_image = true` (verify on-chain via `ai_apps`). The manual **"Propose action"** message-menu
item still works; only the auto-chip is missing on images.

## Root cause: a stale pre-built OpenChat worker bundle

The chip's image branch (`app/src/utils/autoPropose.ts`) only fires when a candidate action reports
`acceptsImage` (it sets `vocabulary.imageTitle` from `actions.find(a => a.acceptsImage)`). That flag
reaches the app via `client.aiApps()`, which runs in the OpenChat **web worker** — served as a
pre-built artifact `openchat-worker/lib/worker.js` (`/worker.js?v=<websiteVersion>`, see
`app/vite.config.ts`; instantiated in `openchat-client/src/workerAgent.ts`).

`acceptsImage` was added to the deserializer `aiActionDefinitionFromWire`
(`openchat-shared/src/domain/aiAction.ts`) in commit **6a5796b3e (2026-07-13)**. A `worker.js` built
*before* that commit maps every other field but silently drops `accepts_image`, so
`action.acceptsImage` is always `undefined` → `imageTitle` is always `undefined` → the image chip
never matches. Text chips keep working because keyword `rules` predate the change.

Confirmed live: the evaluator *does* run on the image (`content.kind === "image_content"`, passes the
freshness filter) but `imageTitle` is `undefined` because the resolved action object has **no
`acceptsImage` key at all**. Static proof: `grep -c accepts_image openchat-worker/lib/worker.js` → `0`
on a stale bundle (the current source mapper is present — `prompt_template` is there — the field just
isn't).

## Fix: rebuild the worker

```sh
cd frontend/openchat-worker && npm run build   # = rollup -c → regenerates lib/worker.js
```

- `worker.js` is a **gitignored build artifact**; rebuilding it is a local-env fix with **no tracked
  repo change**.
- Build on the platform whose native rollup binary is installed. A `node_modules` populated on Windows
  carries `@rollup/rollup-win32-x64-msvc`, so build in **PowerShell**; running `rollup -c` under WSL
  then fails `MODULE_NOT_FOUND` for the missing Linux binary.
- After the rebuild, **clear the browser cache + hard-reload** so the new `/worker.js` loads (the
  `?v=` query is fixed per server start, so a soft reload can serve the cached old worker). A bare
  image then fires the chip. Verified: `accepts_image`/`acceptsImage` occurrences in `worker.js` go
  `0 → 1`, and a caption-less receipt image shows "Propose Add to IOU?".

## Related gotcha: "This message can't be turned into an action"

This toast is result kind `unsupported_content`, returned by `proposeAndPost` when
`contentToInput(content)` returns `undefined` (`app/src/utils/aiActionRunner.ts`). For an **image**
that happens when `content.blobUrl` isn't ready yet — the image hasn't finished downloading /
decrypting into a displayable blob — or the blob `fetch` fails. It occurs **before the model runs**.

So it is a **readiness/timing** failure, not a permanent rejection and not a model miss (a model miss
is `no_extraction` = "The model found no action in this message"). **Retrying "Propose action" on the
same image succeeds once the image has finished loading** (blobUrl populated) — observed directly: a
just-sent image failed, the same receipt once settled extracted `Amount=50 USD → consumed:confirmed`.
The auto-propose *chip* now disappears only after the vouched card is posted successfully. A model,
transport, or card-verification failure leaves that exact suggestion available for retry. A full
page refresh still does not backfill suggestions for old messages, so after refreshing use the
message's **"Propose action" menu item**.

# Local IOU batch replay acceptance

The batch test exercises IOU alone. It does not require a custom OpenChat backend,
ActionInbox, a signed-in browser, or an existing user's keys. Other historical E2E
suites still use their separate environment; this does not qualify those suites.

Set all three variables explicitly, using the running local replica and its IOU
canister ID (not a production target):

```powershell
$env:IOU_BATCH_E2E_HOST = 'http://127.0.0.1:<local-replica-port>'
$env:IOU_BATCH_E2E_CANISTER_ID = '<local-iou-canister-id>'
$env:IOU_BATCH_E2E_ALLOW_WRITES = '1'
node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts test/e2e/entryBatch.e2e.test.ts
```

Only canonical HTTP loopback origins are allowed. Redirects, implicit targets and
skip fallbacks are rejected. A missing environment or failed assertion fails the
test; it is not reported as skipped or successful.

Each run creates fresh ephemeral identities, an isolated pair and sheet, then
tests admission, atomic rollback, response loss after an actual committed batch,
idempotent replay by both members, anonymous/former-member rejection, and closed
sheet rejection. Cleanup affects only that run's newly created pair/sheet and
must succeed. Existing accounts and sheets are not enumerated or reused.

This is real backend receipt/access coverage. It does not prove browser/native
handoff, model extraction, end-to-end authenticated UI recovery, or draft persistence
across a browser restart. The simulated lost response occurs after the real update
has committed; it is not a network-proxy fault injection test.

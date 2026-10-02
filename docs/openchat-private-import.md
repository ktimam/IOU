# Private imports from the unofficial OpenChat client

This is the local-test workflow, not the legacy registered-app/card integration.
IOU and OpenChat have separate sign-ins. Setup does not create an IOU entry, and a
draft received by IOU is not saved until its final review is confirmed.

**2026-10-01 correction:** encrypted delivery from OpenChat is mandatory, not just
encryption at Save. The September 26 plaintext transport is obsolete. Source changes
and passing tests do not update previously installed APKs or served bundles automatically.

## Browser handoff prerequisite

Before delivering drafts through the browser workflow, configure the IOU frontend
with the exact unofficial client's sender origin. For a client served at
`http://localhost:5190`, pass this setting in the environment used to launch Vite
(or to build the frontend when serving built assets):

```text
VITE_LOCAL_IMPORT_SENDER_ORIGIN=http://localhost:5190
```

This is the sender's origin, not IOU's own origin (for example,
`http://localhost:3000`). It must be a canonical HTTP loopback origin: no trailing
slash, path, query, fragment or wildcard. `localhost` and `127.0.0.1` are different
origins. IOU never learns or automatically trusts a sender origin from an incoming
message; a valid browser handoff also requires its launch nonce and exact opener.

Restart the IOU Vite frontend after changing this startup configuration. For built
assets, rebuild with the setting and serve the new assets; a browser reload alone
does not apply a changed launch/build environment. IOU can still render, sign in
and connect or prepare setup files without this setting, so those steps do not prove
that browser handoff is configured. If an expected browser handoff shows **No active
handoff**, check the effective frontend setting for a missing, invalid or outdated
origin, as well as whether the nonce/opener connection was lost.

The native plain-URL flow is separate: it can request explicit, exact-origin,
one-time connection consent without this fixed browser sender setting. Do not
replace that consent with a wildcard or automatically trusted local sender.

## Connect IOU

Use the client's configured public app directory for normal setup. No manual catalog
or processor file downloads or uploads are required.

1. In OpenChat, open **Private apps**. IOU appears automatically when it is listed
   in the operator-configured directory.
2. Choose **Connect** for IOU. Continue to the IOU connection page opened by the
   client; opening `/openchat/connect` directly does not create a setup request.
3. Check the exact **Requesting client** address. Continue only if you recognize
   it and just started this request. Sign in to IOU separately if needed, verify
   the signed-in identity, and choose the intended **Existing active sheet**.
4. Wait for that sheet's private Types to load. Review the account/sheet reminder,
   currency, Type names, keywords and **Owed to you** / **You owe** directions.
   IOU also recovers the signed-in user's delivery keypair and shares ONLY its public
   key/fingerprint and bound recipient context. The private key and separate sheet key,
   fees, schedules, entries and sign-in credentials remain in IOU. No message/image/draft
   is exchanged during setup. Missing or changed delivery keys require reconnection.
5. Choose **Connect / share setup**, then return to OpenChat and check that it
   accepted the setup. Enable IOU in the intended chat; connection does not
   automatically enable it or save an entry.

The setup request expires after ten minutes. If the requester closes, the page
reloads, or the identity/destination changes during setup, start a fresh **Connect**
request. If sharing has an unknown outcome, check OpenChat first; IOU does not
automatically retry. The APK uses its separate local setup bridge, not a browser
login bridge; this procedure is not a claim of native runtime acceptance.

## Setup updates and local storage

Opening **Private apps** refreshes the public directory. Compatible updates from
the same approved publisher are verified and installed without file uploads or
another APK update, provided the client already supports the directory and protocol.
Updates wait while processing or any private cards are retained; a failed update
retains the last working setup. Changes requiring a new private recipe, trust or destination
ask for **Reconnect**. After changing the IOU account, sheet, Types or currency,
reconnect and review the new setup rather than assuming the remembered copy changed.
Changing publisher origin or requiring a new client protocol is not a compatible update.

The local-test client remembers connected or imported setup, selected app/action and
enabled chats on this device, isolated by the signed-in OpenChat account and backend.
That local setup contains private Type names and is not chat-encrypted or synced.
Use **Forget this account's app setup and ALL saved private cards on this device**
to remove setup and all saved cards. Up to eight private cards are saved separately
in a device-local encrypted collection, scoped to OpenChat account/backend.
Approval tokens and transport details remain ephemeral. Restoring a card requires fresh
review; an attempted delivery retains the same request ID and is never retried automatically.
Signing out clears the live card view but retains the encrypted local collection.
**Discard** removes only the selected card, retaining the collection and encryption key
even when no cards remain. **Forget** removes setup, all saved cards and the encryption key.
These local operations do not recall a delivered request or undo an entry already saved in IOU.

## Advanced recovery with setup files

Keep file export/import for explicit recovery, not normal connection. Manually
imported setup is not silently assigned to a publisher or replaced automatically.
When using this recovery path, prepare and import a fresh matching pair after an update.

1. Open `/openchat/import` on the intended IOU deployment and sign in to IOU.
2. Choose an existing active sheet and select **Load this sheet’s private Types**.
3. Expand **Private local-client setup**, then select **Prepare setup files**.
   IOU fetches the public processor and its metadata, verifies its size and SHA-256,
   and prepares the catalog locally. This step does not download either file.
4. Select each download button separately:

   - **Download private setup catalog** → `iou-private-local-app.json`
   - **Download public processor** → `iou-local-processor.js`
5. Confirm that both files finished saving in the browser’s Downloads list. A
   **Download requested** notice is not proof that the browser saved the file. If
   either file is missing or blocked, inspect the browser’s exact status before
   retrying; do not disable browser security protections.
6. In the unofficial client’s **Private apps** workspace, import the catalog and
   matching processor using its file controls. Do not execute the processor file
   directly or paste it into browser developer tools.

The catalog contains private Type names, keywords, directions and currency context.
Keep it out of public repositories and shared diagnostic attachments. The processor
is public code, but the client must still verify it against the catalog’s digest.
Prepare a fresh pair after changing the IOU account, sheet, Types or currency.
Prepared download controls are invalidated when their loaded context changes.

## Saved Types in the sender's private draft

Connected or exported private setup declares IOU's Type labels, IDs and direction
defaults through OpenChat's generic named-choice editor. Selecting a Type updates
its ID/name and direction, never the independent IOU/Settlement kind. Direction edited explicitly
by the user is preserved, including an edit to the same value. Clearing the Type
restores the pre-Type direction unless it was manually edited. Different rows have
independent history; neither selection nor clearing repeats model processing.

The private processor context opts into this host behavior only when the paired
selector is exported. Older contexts retain their previous behavior; public or
empty-Type exports do not include the selector. A client must support the new
declaration before accepting it. Directory-managed setup follows the update/reconnect
rules above; manually imported recovery setup requires a fresh matching pair.

The baseline is held only in the sender's draft session. Advanced JSON preserves
explicit values and disables automatic defaults, including after row reordering.
After card recovery following reload or logout/return, all saved values are treated
as manual. Changing Type still updates its ID/name but does not reapply direction
defaults; clearing Type cannot reconstruct the former direction. Edit direction
explicitly after restoration.
The receiver gets only the final reviewed fields and cannot recover pre-Type values
from sender history. IOU's receiving page remains responsible for current-sheet
validation, fees and schedules. Type labels must be distinct, visible and different
from the selector's None label; invalid labels fail export rather than creating an
unusable catalog.

## Review and deliver

1. Create and review a private draft in the client. Check every outgoing field and
   the destination before explicitly approving the handoff.
2. OpenChat encrypts the fields before its relay/native handoff. IOU accepts only the
   version-2 encrypted offer, not legacy plaintext. Authenticate separately in IOU,
   select the linked receiving account/sheet and decrypt locally with the user's recovered
   delivery private key. Recipient context, destination, action, revision and request ID
   are cryptographically bound. The context is not proof of OpenChat chat membership.
3. Select the received draft, review its Types and fields, then choose
   **Review exact encrypted entry contents**. This final review includes applicable
   IOU-owned fees and schedules, not just the model’s proposed values.
4. Select **Save in IOU** only for the reviewed entry. Entry contents are separately encrypted
   locally for the selected sheet before the authenticated write.

Public discovery never includes recipient keys. The trusted exact-origin Connect flow
provisions them. Delivery uses ephemeral P-256 ECDH, HKDF-SHA256 and AES-256-GCM;
it is independent of ledger sheet encryption. Routing/key/context metadata and message
sizes remain visible; recipientContext is base64url, not encryption. Only authorized IOU
frontend code decrypts the fields for review; malicious frontend code after decryption
remains a threat. No encrypted envelope authenticates the truth of model-extracted fields.

If delivery or saving has an unknown outcome, check the original IOU sheet first.
Use the existing draft’s explicit reopen/retry flow with the same import ID, account
and sheet. Do not generate a new proposal to retry a save: a new proposal has a new
identity and may produce a duplicate. A received acknowledgement alone does not
prove that an entry was persisted.

IOU removes the browser handshake nonce from its URL after capturing it. Reloading
or closing the receiver loses its in-memory handoff and any unsaved received draft;
reloading the plain URL does not restore that browser connection. After correcting
the frontend configuration, use the existing client draft's explicit same-ID retry
(unknown delivery) or reopen (received but unsaved), with fresh consent. Do not
generate a replacement proposal merely to reconnect.

Current local-test acceptance records distinguish successful builds/unit tests from
real authenticated model inference, handoff and saved-entry verification. Do not
treat setup download, APK startup or a rendered draft as end-to-end acceptance.

## Encrypted-handoff source checkpoint: 2026-10-01

Implemented: mandatory sender-side encryption, authenticated recipient-key recovery,
local decryption for second review, and the existing separately encrypted sheet save.
OpenChat saves the active private card encrypted on-device; IOU's received unsaved
draft remains in memory. Old plaintext offers are rejected. Existing connections
without a delivery key must reconnect; there is no plaintext compatibility fallback.

The earlier checkpoint passed 1,946 IOU OpenChat/batch unit tests. After the image-test
additions, the cross-checkout integration passed 98 tests and both IOU TypeScript
checks passed. The integration uses the real OpenChat sender
crypto and IOU receiver, including wrong-key/tamper rejection, no writes on receive,
second-review invalidation and same-ID retry/conflict handling. It mocks authenticated
backend writes; it is not a real saved-entry or installed-APK acceptance test.

The matching OpenChat checkpoint passed 588 feature tests, 777 scoped offline CI
contracts and 18 native handoff harness tests. Actual Edge reload tests verified
encrypted local-card recovery and cross-tab attempted-send protection using synthetic
data only. No model prompt or processor changes were needed for this correction.
The subsequent full OpenChat frontend regression passed 5,065 tests across 338 files,
with no failures, skips or unhandled errors after repairing one outdated test mock.

The expanded integration suite replays four existing, sanitized small-Qwen/Gemma
Arabic and date-range outputs through the real host parser, IOU processor, generic
Type initialization and encrypted handoff. It verifies the original expected fields
and no write before IOU approval, without rerunning either model. A further scoped
unit run passed 421 tests, including two explicit characterizations showing that the
unchanged image contracts cannot preserve printed direction, description or footer-only
Type evidence they never request. Those characterizations are not image-accuracy
passes; the retained historical strict-format failure is still identified as such.

Final review also reproduced and corrected a key-clear race: receive-only recovery
could complete a native secure-storage write after deletion. Recovery now participates
in active-operation tracking and cannot start while deletion is pending. The two
regressions failed before the fix; both key-lifecycle suites now pass 42 tests. The
receive-only path still cannot create or replace keys. A fresh production build passed,
and the existing local frontend serves the correction. No canister update was needed.

Both OpenChat web layouts and local-test APK ABIs were subsequently rebuilt with the
encrypted transport. The local web preview serves the new v2 bundle; IOU's existing
local frontend serves this receiver. The IOU production build also passed. Older
plaintext builds remain incompatible and are not made safe by the source tests.

### Authenticated browser verification

On 2026-10-01, the existing Edge accounts and synthetic test sheet completed a fresh
Connect, sender review, encrypted delivery, authenticated local decryption, second
IOU review and explicit save. A fresh sheet reload confirmed the saved amount, date,
direction and unique test note, including the selected Type's fee and due schedule.

The sender card survived reload before delivery with its original request ID and no
restored consent. After closing the delivery windows and reloading again, it restored
as a locked, uncertain request. An explicitly approved same-ID retry reached IOU,
required its second review, and returned that the earlier save was already accepted.
A fresh sheet reload showed exactly one matching entry, not a duplicate.

This is actual desktop-browser and existing local-backend evidence, not a mocked
write. It uses synthetic text and a manually reviewed test note; it is not image
accuracy, mobile layout, native APK handoff or physical-phone GPU acceptance. No
OpenChat backend change, new account, new sheet or canister deployment was needed.

Separate responsive checks subsequently passed for both web layouts at 390 by 844:
the encrypted sender card restored without consent or horizontal overflow, and both
model screens showed the retained downloads and optional voice controls. No model
configuration changed and no delivery occurred in those checks. They establish the
browser layout only, not Android runtime behavior.

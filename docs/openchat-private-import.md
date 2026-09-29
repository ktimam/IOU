# Private imports from the unofficial OpenChat client

This is the local-test workflow, not the legacy registered-app/card integration.
IOU and OpenChat have separate sign-ins. Setup does not create an IOU entry, and a
draft received by IOU is not saved until its final review is confirmed.

## Browser handoff prerequisite

Before exporting setup for the browser workflow, configure the IOU frontend with
the exact unofficial client's sender origin. For a client served at
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
and prepare setup files without this setting, so those steps do not prove that
browser handoff is configured. If an expected browser handoff shows **No active
handoff**, check the effective frontend setting for a missing, invalid or outdated
origin, as well as whether the nonce/opener connection was lost.

The native plain-URL flow is separate: it can request explicit, exact-origin,
one-time connection consent without this fixed browser sender setting. Do not
replace that consent with a wildcard or automatically trusted local sender.

## Prepare the app-owned setup

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

The updated local-test client remembers imported setup, selected app/action and
enabled chats on this device, isolated by the signed-in OpenChat account and backend.
That local setup contains private Type names and is not chat-encrypted or synced.
Use **Forget this account's app setup on this device** to remove it. Drafts,
recipients, approvals and delivery details remain memory-only; reloading or changing
account discards those, not the separately stored setup.

### Saved Types in the sender's private draft

New private exports declare IOU's Type labels, IDs and direction defaults through
OpenChat's generic named-choice editor. Selecting a Type updates its ID/name and
direction, never the independent IOU/Settlement kind. Direction edited explicitly
by the user is preserved, including an edit to the same value. Clearing the Type
restores the pre-Type direction unless it was manually edited. Different rows have
independent history; neither selection nor clearing repeats model processing.

The private processor context opts into this host behavior only when the paired
selector is exported. Older contexts retain their previous behavior; public or
empty-Type exports do not include the selector. A client must support the new
declaration before importing it. Explicitly prepare/import a fresh matching pair
after updating: existing imports are not replaced automatically.

The baseline is held only in the sender's draft session. Advanced JSON preserves
explicit values and disables automatic defaults, including after row reordering.
The receiver gets only the final reviewed fields and cannot recover pre-Type values
from sender history. IOU's receiving page remains responsible for current-sheet
validation, fees and schedules. Type labels must be distinct, visible and different
from the selector's None label; invalid labels fail export rather than creating an
unusable catalog.

## Review and deliver

1. Create and review a private draft in the client. Check every outgoing field and
   the destination before explicitly approving the handoff.
2. In IOU, authenticate separately if needed and explicitly choose the receiving
   account and sheet. The catalog’s destination label is a reminder, not automatic
   routing or proof of an OpenChat identity or chat membership.
3. Select the received draft, review its Types and fields, then choose
   **Review exact encrypted entry contents**. This final review includes applicable
   IOU-owned fees and schedules, not just the model’s proposed values.
4. Select **Save in IOU** only for the reviewed entry. Entry contents are encrypted
   locally for the selected sheet before the authenticated write.

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

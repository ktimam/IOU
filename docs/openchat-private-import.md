# Private imports from the unofficial OpenChat client

This is the local-test workflow, not the legacy registered-app/card integration.
IOU and OpenChat have separate sign-ins. Setup does not create an IOU entry, and a
draft received by IOU is not saved until its final review is confirmed.

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

The local-test client keeps imported setup and drafts in page memory. Reloading or
changing the OpenChat account discards them; this is not cross-device configuration.

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

Current local-test acceptance records distinguish successful builds/unit tests from
real authenticated model inference, handoff and saved-entry verification. Do not
treat setup download, APK startup or a rendered draft as end-to-end acceptance.

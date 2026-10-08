# Sheet import and export

Open a sheet and choose **Import / export JSON**. This is an IOU sheet tool, not an OpenChat connection or card screen. CSV export remains available for spreadsheets.

## Export

Choose **Download unencrypted JSON**. The versioned file contains the sheet's readable current entries, deleted records and available edit history, account/sheet names, and visible account Types. It contains no credentials or encryption keys. Anyone with the file can read its contents; keep it private and remove copies when no longer needed.

Export fails if any included encrypted record, history version, name or Type slot cannot be read. It does not silently omit unreadable entries. Server timestamps are archived as decimal strings to avoid integer precision loss.

## Import or migrate to another identity

1. Sign in at the destination IOU address. For local cross-device testing, use the same configured HTTPS address and Internet Identity anchor on both devices.
2. Use IOU's normal **New account** flow to create a new account and empty sheet. Choose the desired names there; importing does not rename the destination or transfer membership.
3. Open that sheet's **Import / export JSON**, select the exported file, and review its source, destination, entry count, Types and preview.
4. Confirm and import. Current non-deleted entries and Types are encrypted using the destination sheet's key. The source is never changed or deleted.
5. Check the destination's entries, balances and Types. Reconnect OpenChat to this sheet through its normal Apps/Connect flow; previous approvals and pending cards are not migrated.

For an interrupted import, use **exactly the same file and destination**. Stable backend receipt IDs protect batch retries; the destination is checked against the transformed file before proceeding. A changed file, unrelated existing records or Types, edits/deletions of imported entries, or an inactive sheet are rejected instead of merged. Do not edit the destination concurrently with an import. A network error is not proof that no batch was written.

## What is and is not restored

Entry dates, amounts, currencies, notes, schedules, fees and conversion details are retained. Directions are normalized to the exporting user's view so the new identity sees the same amounts owed. Visible user-defined Types are copied with new IDs.

Imported entries are new records authored by the importing identity, with new server timestamps and entry IDs. Deleted records and historical versions remain in the JSON archive; they are not recreated as original audit history. Source author labels in a user-editable file are not cryptographic proof. Source membership, invitations, chat links, pending cards, closed/archive state and closing balances are not recreated. Existing source and destination names are not overwritten.

One file represents one sheet. Export additional sheets separately and import each into its own new sheet. The format is not a full backend, account-credential or Internet Identity backup. Limits are 16 MiB, 10,000 entries, 100 history versions per entry (50,000 total), and 100 visible Types, also subject to existing encrypted-record/Type-slot limits.

No OpenChat canister changes or model changes are needed for this feature.

# OpenChat and IOU: retained visible conversation export

Export requested on **19 October 2026**. This is a privacy-redacted export of the retained user-facing messages from the current development chat, beginning with the **1 August 2026 security review** and ending after publication of OpenChat Private 0.1.0. It is not a newly reconstructed dialogue or the raw agent session log.

## Files and chronology

| File | Coverage |
| --- | --- |
| [August messages](visible-chat-2026-08.md) | Initial review, original PR integration, environment work and early model experiments |
| [September messages](visible-chat-2026-09.md) | Model/runtime/prompt qualification, app boundaries, release preparation and unofficial-client transition |
| [October messages](visible-chat-2026-10.md) | UI/delivery restoration, production setup, account vault/recovery, code connection and APK publication |
| [Manifest](manifest.json) | Exact retained-message counts, exclusions, source cutoff, monthly byte sizes and SHA-256 digests |

Message headings contain a chronological export number, UTC timestamp and role. Assistant progress updates and final responses remain distinguishable. Very large monthly files may exceed a hosting site's rendered-preview limit; open/download the Markdown file as text to search the full month.

| Retained category | Message records |
| --- | ---: |
| User text / structured replies | 757 |
| Visible assistant progress updates | 8,767 |
| Visible assistant final responses | 833 |
| Total | **10,357** |

These counts include placeholder-only records where private content was removed. Separately, 469 injected user-role context records were excluded rather than presented as human messages. No private attachment bytes are included.

The frozen source cutoff is **2026-10-18T21:06:26.133Z**. The last retained visible update is **2026-10-18T21:04:37.547Z**, or 19 October just after midnight in Cairo. The snapshot includes the export request and its first two progress updates, but not the later file-generation, review, commit or push work. The fixed boundary prevents recursive export of its own implementation. The initiating request was:

> update docs. write a detailed report on everything that was tried since beginning of the chat, what worked and what didn't, and what are the future plans. write another summarized report with everything in a table. export the current chat to chats folder. keep reports in iou repo. commit and push.

## Included and excluded

Included: retained human message text, visible assistant progress/final text and questions embedded in the user's structured question replies. Order and timestamps come from the retained records; missing turns are not invented.

Excluded: system/developer instructions, internal reasoning, compaction summaries, tool calls/results, agent-to-agent messages, injected application/environment/goal context, credentials, binary attachments and raw code/diagnostic blocks. Standalone interactive tool UI that was not stored as visible message text is not reconstructed.

The public copy also removes private account/chat/sheet/device identifiers, personal names/addresses, payment/bank details, one-time codes/PINs, private hosts/IPs, local paths, credential/capability values and URL queries/fragments. Original receipt images and screenshots are **not** copied into this repository. Useful reference-image amounts/dates and public source/release references remain where safely separable.

This is therefore **not an exact verbatim or lossless export**. Placeholders can remove surrounding technical context, and links containing local/private material may no longer be useful. Public technical reports preserve the relevant conclusions without publishing the original private material. The unmodified raw source remains private and is not a release asset.

## Interpretation and validation

Historical messages contain provisional diagnoses, failed attempts, old URLs/UI and results later superseded. An assistant saying “passed” in August is not certification of October's APK. Prefer the [detailed retrospective](../../docs/reports/openchat-iou-retrospective-2026-10-19.md) and [summary tables](../../docs/reports/openchat-iou-summary-2026-10-19.md) for reconciled outcomes, current limitations and future plans.

Publication uses a staging-first redaction workflow, selection/redaction self-tests, whole-output pattern checks and an independent review of the sanitized output and filter rules. These are bounded checks, not a mathematical anonymity guarantee. The manifest records the exact published monthly digests; it is an integrity record, not a signed attestation of every historical claim.

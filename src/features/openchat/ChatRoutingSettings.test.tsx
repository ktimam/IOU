import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  activeRouteSheets,
  buildChatRouteRows,
  chatRouteClaimMessage,
  ChatRoutingView,
  decodeChatRouteClaimOutcome,
  routableSheetIdSet,
  type PendingChatRoute,
} from "./ChatRoutingSettings";

const PENDING_ID = "ab".repeat(32);
const OLDER_PENDING_ID = "cd".repeat(32);
const HOUSE = "1111111111111111";

describe("Chat routing settings", () => {
  it("accepts the BigUint64Array shape returned for Candid vec nat64", () => {
    const wire = BigUint64Array.from([0x0188dbbbfeaca7c7n]);

    expect([...routableSheetIdSet(wire)]).toEqual(["0188dbbbfeaca7c7"]);
  });

  it("keeps ordinary Candid arrays compatible and rejects unrelated wire shapes", () => {
    expect([...routableSheetIdSet([0x1111111111111111n])]).toEqual([
      "1111111111111111",
    ]);
    expect([...routableSheetIdSet(new Uint8Array([1]))]).toEqual([]);
    expect([...routableSheetIdSet(null)]).toEqual([]);
  });

  it("labels active sheets from caller-local decrypted caches, with a non-identity fallback", () => {
    const rows = activeRouteSheets(
      [
        { id: "pair-house", active_sheet_id: ["1111111111111111"], archived_at: [] },
        { id: "pair-child", active_sheet_id: ["2222222222222222"], archived_at: [] },
        { id: "pair-old", active_sheet_id: ["3333333333333333"], archived_at: [1n] },
      ],
      {
        accountNames: { "pair-house": "House" },
        partnerNames: {},
        sheetNames: { "1111111111111111": "August" },
      },
    );
    expect(rows).toEqual([
      { sheetId: "2222222222222222", label: "Account 2" },
      { sheetId: "1111111111111111", label: "House — August" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("pair-child");
  });

  it("keeps app-scoped handles and pending ids out of labels and rendered DOM", () => {
    const pending: PendingChatRoute[] = [{
      pendingId: PENDING_ID,
      chatName: "Manager",
      lastSeen: 10n,
      hasCurrentLink: true,
      currentSheetId: HOUSE,
    }];
    const rows = buildChatRouteRows(pending);
    const html = renderToStaticMarkup(
      <ChatRoutingView
        sheets={[
          { sheetId: HOUSE, label: "House" },
          { sheetId: "2222222222222222", label: "Child" },
        ]}
        rows={rows}
        selections={{ [rows[0].internalKey]: HOUSE }}
      />,
    );
    expect(html).toContain("Manager");
    expect(html).toContain("Save Manager destination");
    expect(html).toContain("Remove link");
    expect(html).toContain("House");
    expect(html).not.toContain(PENDING_ID);
    expect(html).not.toMatch(/group:|channel:|direct:/);
  });

  it("offers save plus dismiss/remove without leaking internal route keys to callbacks", () => {
    const pending = buildChatRouteRows([{
      pendingId: PENDING_ID,
      chatName: "Manager",
      lastSeen: 10n,
      hasCurrentLink: false,
      currentSheetId: null,
    }])[0];
    const onSave = vi.fn();
    const onRemove = vi.fn();
    const html = renderToStaticMarkup(
      <ChatRoutingView
        sheets={[{ sheetId: HOUSE, label: "House" }]}
        rows={[pending]}
        selections={{ [pending.internalKey]: HOUSE }}
        onSave={onSave}
        onRemove={onRemove}
      />,
    );
    expect(html).toContain("Link Manager");
    expect(html).toContain("Dismiss");
    expect(html).not.toContain(PENDING_ID);
    expect(onSave).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("keeps two authenticated token requests independently routable", () => {
    const rows = buildChatRouteRows([
      { pendingId: OLDER_PENDING_ID, chatName: "Mother", lastSeen: 10n, hasCurrentLink: false, currentSheetId: null },
      { pendingId: PENDING_ID, chatName: "Manager", lastSeen: 20n, hasCurrentLink: false, currentSheetId: null },
    ]);
    expect(rows.map((row) => ({
      pendingId: row.pendingId,
      label: row.label,
      isMostRecent: row.isMostRecent,
    }))).toEqual([
      { pendingId: PENDING_ID, label: "Manager", isMostRecent: true },
      { pendingId: OLDER_PENDING_ID, label: "Mother", isMostRecent: false },
    ]);

    const html = renderToStaticMarkup(
      <ChatRoutingView
        sheets={[{ sheetId: HOUSE, label: "House" }]}
        rows={rows}
        selections={Object.fromEntries(rows.map((row) => [row.internalKey, HOUSE]))}
      />,
    );
    expect(html).not.toContain("older anonymous requests cannot be reassigned");
    expect(html.match(/<select[^>]*disabled=""/g)).toBeNull();
    expect(html).toContain("Link Manager");
    expect(html).toContain("Link Mother");
    expect(html).not.toContain(PENDING_ID);
    expect(html).not.toContain(OLDER_PENDING_ID);
  });

  it("decodes only an opaque pending id and keeps account-mismatch messages token-free", () => {
    expect(decodeChatRouteClaimOutcome({
      Success: { pending_id: PENDING_ID },
    })).toEqual({ kind: "success", pendingId: PENDING_ID });
    expect(decodeChatRouteClaimOutcome({
      Success: { pending_id: "group:raw" },
    })).toEqual({ kind: "remote-error" });
    expect(decodeChatRouteClaimOutcome({ WrongAccount: null })).toEqual({
      kind: "wrong-account",
    });
    const message = chatRouteClaimMessage({ kind: "wrong-account" });
    expect(message).toMatch(/different connected OpenChat account/i);
    expect(message).toMatch(/has not been used/i);
    expect(message).not.toContain(PENDING_ID);
    expect(message).not.toMatch(/group:|channel:|direct:/i);
  });

  it("keeps a closed or inaccessible saved destination removable without rendering its id", () => {
    const rows = buildChatRouteRows([{
      pendingId: PENDING_ID,
      chatName: "Manager",
      lastSeen: 20n,
      hasCurrentLink: true,
      currentSheetId: null,
    }]);
    const html = renderToStaticMarkup(
      <ChatRoutingView
        sheets={[{ sheetId: HOUSE, label: "House" }]}
        rows={rows}
        selections={{ [rows[0].internalKey]: "" }}
      />,
    );
    expect(html).toContain("saved destination");
    expect(html).toContain("Remove link");
    expect(html).not.toContain(PENDING_ID);
  });

  it("renders a durable saved link after its temporary setup request has expired", () => {
    const rows = buildChatRouteRows([{
      pendingId: PENDING_ID,
      chatName: "Mother",
      lastSeen: 0n,
      hasCurrentLink: true,
      currentSheetId: HOUSE,
    }]);
    const html = renderToStaticMarkup(
      <ChatRoutingView
        sheets={[{ sheetId: HOUSE, label: "House" }]}
        rows={rows}
        selections={{ [rows[0].internalKey]: HOUSE }}
      />,
    );
    expect(html).toContain("Mother");
    expect(html).toMatch(/Mother.*→.*House/);
    expect(html).not.toContain("Chat name (only on this device)");
    expect(html).toContain("saved routing destination");
    expect(html).not.toContain("Requested 1/1/1970");
    expect(html).not.toContain(PENDING_ID);
  });

  it("explains why only completed Open setup routes appear", () => {
    const rows = buildChatRouteRows([{
      pendingId: PENDING_ID,
      chatName: "Mother",
      lastSeen: 0n,
      hasCurrentLink: true,
      currentSheetId: HOUSE,
    }]);
    const html = renderToStaticMarkup(
      <ChatRoutingView
        sheets={[{ sheetId: HOUSE, label: "FatherMother — 2026" }]}
        rows={rows}
        selections={{ [rows[0].internalKey]: HOUSE }}
      />,
    );
    expect(html).toMatch(/1 chat route/i);
    expect(html).toMatch(/add another.*Open setup.*exact OpenChat chat/i);
    expect(html).toMatch(/Mother.*→.*FatherMother — 2026/);
  });

  it("never preselects or enables a fresh route even when there is one sheet", () => {
    const rows = buildChatRouteRows([{
      pendingId: PENDING_ID,
      chatName: "Manager",
      lastSeen: 20n,
      hasCurrentLink: false,
      currentSheetId: null,
    }]);
    const html = renderToStaticMarkup(
      <ChatRoutingView
        sheets={[{ sheetId: HOUSE, label: "House" }]}
        rows={rows}
        selections={{ [rows[0].internalKey]: "" }}
      />,
    );
    expect(html).toContain('<option value="" selected="">Choose an account / sheet</option>');
    expect(html).toMatch(/<button disabled="">Link Manager<\/button>/);
  });

  it("shows truthful first-use and no-account empty states", () => {
    const noAccount = renderToStaticMarkup(
      <ChatRoutingView sheets={[]} rows={[]} selections={{}} />,
    );
    expect(noAccount).toMatch(/Create an active IOU account\/sheet/i);
    const waiting = renderToStaticMarkup(
      <ChatRoutingView
        sheets={[{ sheetId: "1111111111111111", label: "House" }]}
        rows={[]}
        selections={{}}
      />,
    );
    expect(waiting).toMatch(/chat settings.*AI apps.*Open setup/i);
    expect(waiting).toMatch(/card does not link a sheet/i);
    expect(waiting).not.toMatch(/connect again|reconnect/i);
  });
});

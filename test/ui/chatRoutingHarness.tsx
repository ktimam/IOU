import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  buildChatRouteRows,
  ChatRoutingView,
  type ChatRouteRow,
} from "../../src/features/openchat/ChatRoutingSettings";

const RECENT_ID = "ab".repeat(32);
const OLDER_ID = "cd".repeat(32);
const HOUSE = "1111111111111111";
const CHILD = "2222222222222222";

function Harness() {
  const viewer = sessionStorage.getItem("iou.test.chatRouting.viewer") ?? "father";
  const [pending, setPending] = useState(
    viewer === "father"
      ? [
          { pendingId: RECENT_ID, lastSeen: 20n, hasCurrentLink: false, currentSheetId: null },
          { pendingId: OLDER_ID, lastSeen: 10n, hasCurrentLink: false, currentSheetId: null },
        ]
      : [],
  );
  const [selections, setSelections] = useState<Record<string, string>>({
    [`pending:${RECENT_ID}`]: "",
    [`pending:${OLDER_ID}`]: HOUSE,
  });
  const [status, setStatus] = useState<string | null>(null);
  const rows = useMemo(() => buildChatRouteRows(pending), [pending]);

  function save(row: ChatRouteRow) {
    const sheetId = selections[row.internalKey];
    const label = sheetId === HOUSE ? "House" : sheetId === CHILD ? "Child" : "unknown";
    const wasLinked = row.hasCurrentLink;
    setPending((current) =>
      current.map((candidate) =>
        candidate.pendingId === row.pendingId
          ? { ...candidate, hasCurrentLink: true, currentSheetId: sheetId }
          : candidate),
    );
    setStatus(`${wasLinked ? "Destination saved" : "Pending chat linked"}: ${label}`);
  }

  function remove(row: ChatRouteRow) {
    if (row.hasCurrentLink && row.isMostRecent) {
      setPending((current) =>
        current.map((candidate) =>
          candidate.pendingId === row.pendingId
            ? { ...candidate, hasCurrentLink: false, currentSheetId: null }
            : candidate),
      );
      setStatus("Chat link removed.");
      return;
    }
    setPending((current) =>
      current.filter((candidate) => candidate.pendingId !== row.pendingId));
    setStatus("Recent chat request dismissed.");
  }

  return (
    <ChatRoutingView
      sheets={[
        { sheetId: HOUSE, label: "House" },
        { sheetId: CHILD, label: "Child" },
      ]}
      rows={rows}
      selections={selections}
      status={status}
      onSelect={(internalKey, sheetId) =>
        setSelections((current) => ({ ...current, [internalKey]: sheetId }))}
      onSave={save}
      onRemove={remove}
    />
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing chat-routing harness root");
createRoot(root).render(<Harness />);

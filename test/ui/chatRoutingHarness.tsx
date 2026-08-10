import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  buildChatRouteRows,
  ChatRoutingSettingsContent,
  ChatRoutingView,
  type ChatRouteRow,
} from "../../src/features/openchat/ChatRoutingSettings";
import {
  captureOpenChatRoutingLaunch,
  clearOpenChatRoutingLaunch,
  consumeAndScrubOpenChatRoutingFragment,
} from "../../src/features/openchat/chatLinkLaunch";

const RECENT_ID = "ab".repeat(32);
const OLDER_ID = "cd".repeat(32);
const HOUSE = "1111111111111111";
const CHILD = "2222222222222222";
const TOKEN_FOR_RECENT = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg";
const TOKEN_FOR_OLDER = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";

function pendingIdForLaunchToken(token: string | null): string | null {
  return token === TOKEN_FOR_RECENT
    ? RECENT_ID
    : token === TOKEN_FOR_OLDER
      ? OLDER_ID
      : null;
}

const capturedLaunchToken = captureOpenChatRoutingLaunch();
const launchedPendingId = pendingIdForLaunchToken(capturedLaunchToken);

const productionStats = { claimCalls: 0, finishedCalls: 0 };
let productionPendingReady = false;
let releaseProductionClaim!: () => void;
const productionClaimGate = new Promise<void>((resolve) => {
  releaseProductionClaim = resolve;
});
const productionActor = {
  async get_my_pairs() {
    return [{ id: "pair-house", active_sheet_id: [HOUSE], archived_at: [] }];
  },
  async chat_routable_sheet_ids() {
    return [BigInt(`0x${HOUSE}`)];
  },
  async pending_chat_routes() {
    return productionPendingReady
      ? [
          {
            pending_id: RECENT_ID,
            chat_name: ["Manager"],
            last_seen: 30n,
            has_current_link: false,
            current_sheet_id: [],
          },
          {
            pending_id: OLDER_ID,
            chat_name: ["Mother"],
            last_seen: 20n,
            has_current_link: false,
            current_sheet_id: [],
          },
        ]
      : [];
  },
  async claim_openchat_chat_route() {
    productionStats.claimCalls += 1;
    await productionClaimGate;
    productionPendingReady = true;
    return { Success: { pending_id: OLDER_ID } };
  },
  async assign_pending_chat_route() {},
  async dismiss_pending_chat_route() {},
  async remove_pending_chat_route_link() {},
  async chat_sheet_links() { return []; },
};
const productionPrefs = {
  defaultCurrency: "USD",
  profileName: "Father",
  accountNames: { "pair-house": "House" },
  partnerNames: {},
  sheetNames: { [HOUSE]: "August" },
};

const ambiguousClaimStats = {
  claimTokens: [] as string[],
  finishedTokens: [] as string[],
};
let ambiguousPendingReady = false;
const ambiguousClaimActor = {
  async get_my_pairs() {
    return [{ id: "pair-house", active_sheet_id: [HOUSE], archived_at: [] }];
  },
  async chat_routable_sheet_ids() {
    return [BigInt(`0x${HOUSE}`)];
  },
  async pending_chat_routes() {
    return ambiguousPendingReady
      ? [{
          pending_id: OLDER_ID,
          chat_name: ["Mother"],
          last_seen: 20n,
          has_current_link: false,
          current_sheet_id: [],
        }]
      : [];
  },
  async claim_openchat_chat_route(token: string) {
    ambiguousClaimStats.claimTokens.push(token);
    // Model an ambiguous response: the backend committed the route, but the first response was
    // lost/indeterminate. The UI must retain and retry the exact same launch bearer.
    ambiguousPendingReady = true;
    return ambiguousClaimStats.claimTokens.length === 1
      ? { RemoteError: null }
      : { Success: { pending_id: OLDER_ID } };
  },
  async assign_pending_chat_route() {},
  async dismiss_pending_chat_route() {},
  async remove_pending_chat_route_link() {},
  async chat_sheet_links() { return []; },
};

function AmbiguousClaimHarness() {
  const [launchToken, setLaunchToken] = useState(capturedLaunchToken);
  const finishLaunch = useCallback((token: string) => {
    ambiguousClaimStats.finishedTokens.push(token);
    clearOpenChatRoutingLaunch(token);
    setLaunchToken((current) => (current === token ? null : current));
  }, []);
  (window as typeof window & {
    __iouAmbiguousChatRoutingStats?: typeof ambiguousClaimStats;
  }).__iouAmbiguousChatRoutingStats = ambiguousClaimStats;

  return (
    <ChatRoutingSettingsContent
      actor={ambiguousClaimActor}
      prefs={productionPrefs}
      principal="father-principal"
      launchToken={launchToken}
      onLaunchTokenFinished={finishLaunch}
    />
  );
}

function ProductionClaimHarness() {
  const [launchToken, setLaunchToken] = useState(capturedLaunchToken);
  const finishLaunch = useCallback((token: string) => {
    productionStats.finishedCalls += 1;
    clearOpenChatRoutingLaunch(token);
    setLaunchToken((current) => (current === token ? null : current));
  }, []);
  (window as typeof window & { __iouChatRoutingStats?: typeof productionStats })
    .__iouChatRoutingStats = productionStats;
  (window as typeof window & { __iouReleaseChatRoutingClaim?: () => void })
    .__iouReleaseChatRoutingClaim = releaseProductionClaim;

  return (
    <ChatRoutingSettingsContent
      actor={productionActor}
      prefs={productionPrefs}
      principal="father-principal"
      launchToken={launchToken}
      onLaunchTokenFinished={finishLaunch}
    />
  );
}

function Harness() {
  const viewer = sessionStorage.getItem("iou.test.chatRouting.viewer") ?? "father";
  const [pending, setPending] = useState(
    viewer === "father"
      ? [
          { pendingId: RECENT_ID, chatName: "Manager", lastSeen: 20n, hasCurrentLink: false, currentSheetId: null },
          { pendingId: OLDER_ID, chatName: "Mother", lastSeen: 10n, hasCurrentLink: false, currentSheetId: null },
        ]
      : [],
  );
  const [selections, setSelections] = useState<Record<string, string>>({
    [`pending:${RECENT_ID}`]: "",
    [`pending:${OLDER_ID}`]: HOUSE,
  });
  const [status, setStatus] = useState<string | null>(null);
  const [focusedPendingId, setFocusedPendingId] = useState(launchedPendingId);
  useEffect(() => {
    const captureLaunch = () => setFocusedPendingId(pendingIdForLaunchToken(
      consumeAndScrubOpenChatRoutingFragment(window.location, window.history),
    ));
    window.addEventListener("hashchange", captureLaunch);
    return () => window.removeEventListener("hashchange", captureLaunch);
  }, []);
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
    if (row.hasCurrentLink) {
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
    setStatus("Chat request dismissed.");
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
      focusedPendingId={focusedPendingId}
      onSelect={(internalKey, sheetId) =>
        setSelections((current) => ({ ...current, [internalKey]: sheetId }))}
      onSave={save}
      onRemove={remove}
      onRouteFocused={() => setFocusedPendingId(null)}
    />
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing chat-routing harness root");
const productionClaim = sessionStorage.getItem("iou.test.chatRouting.productionClaim") === "1";
const ambiguousClaim = sessionStorage.getItem("iou.test.chatRouting.ambiguousClaim") === "1";
createRoot(root).render(
  ambiguousClaim
    ? <StrictMode><AmbiguousClaimHarness /></StrictMode>
    : productionClaim
    ? <StrictMode><ProductionClaimHarness /></StrictMode>
    : <Harness />,
);

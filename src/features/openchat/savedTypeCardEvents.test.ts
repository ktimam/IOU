// Offline event-wiring unit tests: invoke the real page's React element handlers using controlled
// hooks. Effects/DOM/device behaviour are intentionally not simulated or claimed as acceptance.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryDraft } from "../entries/draft";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { buildConfirmPayload, initToFormState, type CardFormState } from "./cardBridge";
import { hydrateSavedTypeForCard, OpenChatCardPage } from "./OpenChatCardPage";

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hooks.stateIndex++;
      if (!(index in hooks.states)) {
        hooks.states[index] = typeof initial === "function" ? initial() : initial;
      }
      return [hooks.states[index], (value: unknown) => {
        hooks.states[index] = typeof value === "function" ? value(hooks.states[index]) : value;
      }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.refIndex++;
      return hooks.refs[index] ??= { current: initial };
    },
    useCallback: (callback: unknown) => callback,
    useMemo: (factory: () => unknown) => factory(),
    useEffect: () => undefined,
  };
});

const TYPE: TxnTemplate = {
  id: "private-studio",
  name: "Studio hire",
  direction: "debt",
  txn_type: "iou",
};

type ElementProps = {
  children?: ReactNode;
  "aria-label"?: string;
  value?: string;
  onChange?: (event: { target: { value: string } }) => void;
};

function controls(node: ReactNode, label: string): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap((child) => controls(child, label));
  if (!isValidElement<ElementProps>(node)) return [];
  if (node.props["aria-label"] === label) return [node];
  if (typeof node.type === "function") {
    // Only this card's pure child components are expanded; the page hook state is controlled above.
    const component = node.type as (props: ElementProps) => ReactNode;
    return controls(component(node.props), label);
  }
  return controls(node.props.children, label);
}

function renderPage() {
  hooks.stateIndex = 0;
  hooks.refIndex = 0;
  return OpenChatCardPage();
}

function seedPage(raw: EntryDraft, rows?: EntryDraft[], templates: TxnTemplate[] = [TYPE]) {
  renderPage();
  // Guard the real page's hook layout so a refactor fails instead of silently seeding another slot.
  expect(hooks.states).toEqual([
    null, initToFormState({}), null, false, [], { kind: "waiting" },
  ]);
  hooks.states[0] = { readonly: false, theme: "dark" };
  hooks.states[1] = initToFormState(raw);
  hooks.states[2] = rows?.map((row) => initToFormState(row)) ?? null;
  hooks.states[4] = templates;
  hooks.states[5] = { kind: templates.length === 0 ? "loading" : "ready" };
  return renderPage();
}

function change(tree: ReactNode, label: string, value: string, index = 0) {
  const control = controls(tree, label)[index];
  expect(control?.props.onChange).toBeTypeOf("function");
  control.props.onChange!({ target: { value } });
}

beforeEach(() => {
  hooks.states = [];
  hooks.refs = [];
  hooks.stateIndex = 0;
  hooks.refIndex = 0;
});

describe("actual IOU card select/input event wiring", () => {
  it("applies saved direction through the rendered type selector and retains the next manual edit", () => {
    const tree = seedPage({ note: "Studio hire", amount: 25, currency: "USD", kind: "iou" });
    change(tree, "Saved type", TYPE.id);
    expect(controls(renderPage(), "Direction")[0].props.value).toBe("debt");
    // Deliberately use handlers captured before rerender. Consecutive user edits must read the
    // current ref, not replace a previous edit using a stale captured form.
    change(tree, "Direction", "credit");
    change(tree, "Note", "User changed note");
    const state = hooks.states[1] as CardFormState;
    expect(state).toMatchObject({ templateId: TYPE.id, direction: "credit", directionEdited: true });
    expect(buildConfirmPayload(state)).toMatchObject({ direction: "credit", note: "User changed note" });
    expect(hydrateSavedTypeForCard(state, { note: "Studio hire" }, [TYPE]).direction).toBe("credit");
  });

  it("remembers a rendered direction/None edit before private hydration", () => {
    const raw = { note: "Studio hire" };
    const tree = seedPage(raw, undefined, []);
    change(tree, "Direction", "credit");
    change(tree, "Saved type", "");
    const hydrated = hydrateSavedTypeForCard(hooks.states[1] as CardFormState, raw, [TYPE]);
    expect(hydrated.templateId).toBeUndefined();
    expect(hydrated.direction).toBe("credit");
    expect(hydrated.directionEdited).toBe(true);
    expect(hydrated.savedTypeSelectionEdited).toBe(true);
  });

  it("routes multi-row type/direction edits only to that row and renders the shared wording", () => {
    const tree = seedPage({}, [{ note: "Studio hire" }, { note: "Other expense" }]);
    change(tree, "Saved type", TYPE.id, 0);
    change(tree, "Direction", "debt", 1);
    change(tree, "Note", "Edited second row", 1);
    const rows = hooks.states[2] as CardFormState[];
    expect(rows[0]).toMatchObject({ templateId: TYPE.id, direction: "debt" });
    expect(rows[0].directionEdited).toBeUndefined();
    expect(rows[1]).toMatchObject({ direction: "debt", directionEdited: true, note: "Edited second row" });
    expect(rows[1].templateId).toBeUndefined();
    const directionControls = controls(renderPage(), "Direction");
    expect(directionControls.map(({ props }) => props.value)).toEqual(["debt", "debt"]);
    for (const control of directionControls) {
      const options = control.props.children as ReactElement<ElementProps>[];
      expect(options.map(({ props }) => props.children)).toEqual(["Owed to you", "You owe"]);
    }
  });
});

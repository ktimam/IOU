import type { Direction } from "./types";

// Display copy only. Stored directions and viewer-relative accounting keep their existing enums.
export const DIRECTION_LABELS = {
  credit: "Owed to you",
  debt: "You owe",
} as const satisfies Record<Direction, string>;

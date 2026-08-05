export type E2EMode = "run" | "skip";

export function resolveE2EMode(input: {
  up: boolean;
  reason: string;
  allowSkip: boolean;
}): E2EMode {
  if (input.up) return "run";
  if (input.allowSkip) return "skip";
  throw new Error(
    `Required E2E environment is unavailable: ${input.reason}. ` +
      "Start the documented local stack, or set IOU_E2E_ALLOW_SKIP=1 only for an intentional developer skip.",
  );
}

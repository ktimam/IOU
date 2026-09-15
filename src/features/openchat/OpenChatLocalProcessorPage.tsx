import { useEffect } from "react";
import { attachIouLocalProcessor } from "./localProcessorBridge";
import { iouImageProcessorOptions } from "./modelImageProfiles";

export function OpenChatLocalProcessorPage() {
  useEffect(() => attachIouLocalProcessor(undefined, iouImageProcessorOptions), []);
  return null;
}

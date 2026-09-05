import { useEffect } from "react";
import { attachIouLocalProcessor } from "./localProcessorBridge";

export function OpenChatLocalProcessorPage() {
  useEffect(() => attachIouLocalProcessor(), []);
  return null;
}

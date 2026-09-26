import { processLocalArtifactRequest } from "./localProcessorArtifact";

let completed = false;
self.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (completed) return;
  completed = true;
  try { self.postMessage(processLocalArtifactRequest(event.data)); }
  catch { self.postMessage({ kind: "error" }); }
});

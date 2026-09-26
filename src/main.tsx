import { captureOpenChatRoutingLaunch } from "./features/openchat/chatLinkLaunch";
import { captureLocalImportLaunch } from "./features/openchat/localImportLaunch";

// This must run before importing React, AuthProvider, or any session-restoration code. The dynamic
// import is a deliberate security boundary: a one-time chat-link token is removed from the visible
// URL/history synchronously, while its value remains only in chatLinkLaunch's module memory.
captureOpenChatRoutingLaunch();
captureLocalImportLaunch();

export const appBootstrap = import("./bootstrapApp");

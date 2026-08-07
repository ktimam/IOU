import { captureOpenChatRoutingLaunch } from "./features/openchat/chatLinkLaunch";

// This must run before importing React, AuthProvider, or any session-restoration code. The dynamic
// import is a deliberate security boundary: a one-time chat-link token is removed from the visible
// URL/history synchronously, while its value remains only in chatLinkLaunch's module memory.
captureOpenChatRoutingLaunch();

export const appBootstrap = import("./bootstrapApp");

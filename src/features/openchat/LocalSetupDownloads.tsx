export type LocalSetupDownload = Readonly<{ href: string; name: string; label: string }>;

export type LocalSetupContext = {
  principal: string; pairId: string; sheetId: string; defaultCurrency: string;
  actor: unknown; identity: unknown; binding: unknown; shared: unknown; readyGeneration: unknown; ready: boolean;
};

export function localSetupContextMatches(captured: LocalSetupContext, live: LocalSetupContext): boolean {
  return live.ready && !!live.actor && !!live.identity && !!live.readyGeneration &&
    captured.principal === live.principal && captured.pairId === live.pairId && captured.sheetId === live.sheetId &&
    captured.defaultCurrency === live.defaultCurrency && captured.shared === live.shared &&
    captured.actor === live.actor && captured.identity === live.identity && captured.binding === live.binding &&
    captured.readyGeneration === live.readyGeneration;
}

export async function verifiedLocalSetupProcessor() {
  const [metadataResponse, sourceResponse] = await Promise.all([
    fetch("/openchat/local-processor-v1.sha256.json", { credentials: "omit", cache: "no-store" }),
    fetch("/openchat/local-processor-v1.js", { credentials: "omit", cache: "no-store" }),
  ]);
  if (!metadataResponse.ok || !sourceResponse.ok) throw new Error("Processor download failed");
  const metadata = await metadataResponse.json() as { sha256: string; byteLength: number };
  if (!/^[a-f0-9]{64}$/.test(metadata.sha256) || !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 1 || metadata.byteLength > 512 * 1024) throw new Error("Invalid processor metadata");
  const source = await sourceResponse.arrayBuffer();
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", source)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== metadata.sha256 || source.byteLength !== metadata.byteLength) throw new Error("Processor integrity mismatch");
  return { metadata, source };
}

/** Each prepared file needs its own user click; one click must never start two downloads. */
export function createLocalSetupDownloadFiles(catalog: unknown, processor: ArrayBuffer) {
  const files: LocalSetupDownload[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const file of files) URL.revokeObjectURL(file.href);
  };
  try {
    files.push({ name: "iou-private-local-app.json", label: "Download private setup catalog",
      href: URL.createObjectURL(new Blob([JSON.stringify(catalog, null, 2)], { type: "application/json" })) });
    files.push({ name: "iou-local-processor.js", label: "Download public processor",
      href: URL.createObjectURL(new Blob([processor], { type: "text/javascript" })) });
    return { files: Object.freeze(files), dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Own allocated URLs immediately, including before React commits the prepared UI. */
export function createLocalSetupDownloadOwner() {
  let active: { dispose: () => void } | undefined;
  const clear = () => { active?.dispose(); active = undefined; };
  return { clear, replace(next: { dispose: () => void }) { clear(); active = next; } };
}

export function LocalSetupDownloads({ files, disabled, assertCurrent, onRequest, onError }: {
  files: readonly LocalSetupDownload[];
  disabled: boolean;
  assertCurrent: () => void;
  onRequest: (file: LocalSetupDownload) => void;
  onError: () => void;
}) {
  return <div>
    <p>Download each file separately, then import both locally in the client. Check your browser’s Downloads list for completion. Keep the catalog private.</p>
    {files.map((file) => <p key={file.name}>
      <button disabled={disabled} onClick={() => {
        if (disabled) return;
        try {
          // No permanent href: alternative activation must not bypass the session check.
          // This synchronous user gesture requests just one already-verified file.
          assertCurrent();
          const link = document.createElement("a");
          link.href = file.href; link.download = file.name; link.click();
          onRequest(file);
        } catch { onError(); }
      }}>{file.label}</button>
    </p>)}
  </div>;
}

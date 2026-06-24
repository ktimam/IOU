// QR scanner (v1.1.5) — camera-based, dependency-free.
//
// Uses the platform BarcodeDetector API (Chromium desktop + Android WebView)
// over a getUserMedia camera stream. No native plugin and no JS barcode lib, so
// it runs in the dev browser (localhost is a secure context) and inside the
// Capacitor Android shell (needs the CAMERA permission in AndroidManifest).
// Falls back to a clear message where BarcodeDetector / camera is unavailable
// (e.g. iOS Safari today) — the user can still paste.

import { useEffect, useRef, useState } from "react";

type DetectedBarcode = { rawValue: string };
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: {
      new (opts?: { formats?: string[] }): BarcodeDetectorLike;
    };
  }
}

export function QrScanner({
  onResult,
  onClose,
}: {
  onResult: (text: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!window.BarcodeDetector) {
      setError("QR scanning isn’t supported on this device/browser — paste instead.");
      return;
    }
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const detector = new window.BarcodeDetector({ formats: ["qr_code"] });

    const tick = async () => {
      if (stopped || !videoRef.current) return;
      try {
        const codes = await detector.detect(videoRef.current);
        const hit = codes.find((c) => c.rawValue && c.rawValue.trim());
        if (hit) {
          onResult(hit.rawValue.trim());
          return; // stop the loop; parent closes us
        }
      } catch {
        /* transient decode error — keep scanning */
      }
      raf = requestAnimationFrame(() => void tick());
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (stopped) return;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          raf = requestAnimationFrame(() => void tick());
        }
      } catch {
        setError("Couldn’t open the camera — check permissions, or paste instead.");
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3>Scan QR</h3>
        {error ? (
          <p style={{ color: "var(--debt)" }}>{error}</p>
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            style={{ width: "100%", borderRadius: 8, background: "#000" }}
          />
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// Tiny toast system. One provider, useToasts() hook.
//
// Usage:
//   const { show } = useToasts();
//   show("Entry added");
//   show({ kind: "error", text: "Failed" });
//   show({ kind: "info", text: "...", ms: 6000 });

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

type ToastKind = "info" | "success" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  ms: number;
}

interface ToastApi {
  show: (arg: string | { kind?: ToastKind; text: string; ms?: number }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback<ToastApi["show"]>((arg) => {
    const opts = typeof arg === "string" ? { text: arg } : arg;
    const id = nextId++;
    const t: Toast = {
      id,
      kind: opts.kind ?? "info",
      text: opts.text,
      ms: opts.ms ?? 4000,
    };
    setToasts((prev) => [...prev, t]);
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) =>
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, t.ms),
    );
    return () => timers.forEach(clearTimeout);
  }, [toasts]);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToasts() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToasts must be inside <ToastProvider>");
  return ctx;
}

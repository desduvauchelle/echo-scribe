import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastTone = "info" | "error" | "success";

export type ToastInput = {
  tone: ToastTone;
  message: string;
  /** ms before auto-dismiss; default 5000. Set to 0 to keep until dismissed. */
  durationMs?: number;
  action?: { label: string; onClick: () => void };
};

type Toast = ToastInput & { id: number };

type Ctx = {
  push: (toast: ToastInput) => void;
};

const ToastCtx = createContext<Ctx | null>(null);

const TONE_BORDER: Record<ToastTone, string> = {
  info: "border-neutral-700",
  error: "border-red-700",
  success: "border-emerald-700",
};

const TONE_DOT: Record<ToastTone, string> = {
  info: "text-neutral-400",
  error: "text-red-400",
  success: "text-emerald-400",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast: ToastInput) => {
      idRef.current += 1;
      const id = idRef.current;
      setToasts((prev) => [...prev, { ...toast, id }]);
      const duration = toast.durationMs ?? 5000;
      if (duration > 0) {
        window.setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss],
  );

  const ctx = useMemo<Ctx>(() => ({ push }), [push]);

  return (
    <ToastCtx.Provider value={ctx}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex max-w-[420px] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2 rounded-md border ${TONE_BORDER[t.tone]} bg-neutral-900 px-3 py-2 text-sm text-neutral-100 shadow-lg`}
          >
            <span className={`mt-0.5 ${TONE_DOT[t.tone]}`}>
              {t.tone === "error" ? "!" : t.tone === "success" ? "✓" : "•"}
            </span>
            <span className="flex-1 whitespace-pre-wrap break-words">
              {t.message}
            </span>
            {t.action ? (
              <button
                type="button"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                className="rounded border border-neutral-700 px-2 py-0.5 text-xs hover:bg-neutral-800"
              >
                {t.action.label}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="ml-1 text-neutral-400 hover:text-neutral-100"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToasts(): Ctx {
  const ctx = useContext(ToastCtx);
  if (!ctx) {
    throw new Error("useToasts must be used inside <ToastProvider>");
  }
  return ctx;
}

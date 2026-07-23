import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

export type ToastTone = "info" | "error" | "success";

const TONE_ICON = {
  info: Info,
  error: AlertCircle,
  success: CheckCircle2,
} as const;

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
  info: "border-line",
  error: "border-danger/50",
  success: "border-success/50",
};

const TONE_ICON_COLOR: Record<ToastTone, string> = {
  info: "text-muted",
  error: "text-danger",
  success: "text-success",
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
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[80] flex max-w-[420px] flex-col gap-2"
      >
        {toasts.map((t) => {
          const Icon = TONE_ICON[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === "error" ? "alert" : "status"}
              className={`pointer-events-auto flex items-start gap-2 rounded-md border ${TONE_BORDER[t.tone]} bg-surface px-3 py-2 text-[13px] text-fg shadow-lg shadow-black/40`}
            >
              <Icon
                size={14}
                strokeWidth={2}
                className={`mt-0.5 shrink-0 ${TONE_ICON_COLOR[t.tone]}`}
              />
              <span className="flex-1 whitespace-pre-wrap break-words leading-snug">
                {t.message}
              </span>
              {t.action ? (
                <button
                  type="button"
                  onClick={() => {
                    t.action?.onClick();
                    dismiss(t.id);
                  }}
                  className="cursor-pointer rounded-md border border-line px-2 py-0.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-fg"
                >
                  {t.action.label}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="ml-0.5 cursor-pointer rounded p-0.5 text-faint transition-colors hover:bg-elevated hover:text-fg"
                aria-label="Dismiss"
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          );
        })}
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

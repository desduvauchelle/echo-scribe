import { useEffect, useRef, type ReactNode, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Focus management for modal surfaces: while `active`,
 * - moves focus into `panelRef` (first focusable, else the panel itself —
 *   give the panel `tabIndex={-1}` so that works),
 * - traps Tab / Shift+Tab inside the panel, and
 * - restores focus to the previously-focused element on deactivate/unmount.
 *
 * Used by `Dialog`; also usable standalone for slide-overs that stay mounted.
 */
export function useFocusTrap(
  panelRef: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const panel = panelRef.current;
    if (!panel) return;
    const previous = document.activeElement as HTMLElement | null;

    // Only steal focus if it isn't already inside the panel (e.g. autoFocus).
    if (!panel.contains(document.activeElement)) {
      const first = focusables(panel)[0];
      (first ?? panel).focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables(panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey) {
        if (current === first || !panel.contains(current)) {
          e.preventDefault();
          last.focus();
        }
      } else if (current === last || !panel.contains(current)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [panelRef, active]);
}

/**
 * Accessible modal wrapper: dialog semantics, focus trap + restore, Escape
 * close, and backdrop click close (Escape covers keyboard users). Styling is
 * fully caller-supplied via `className` (backdrop) and `panelClassName`
 * (panel) so existing Tailwind stays intact.
 *
 * NOTE: never reach for window.confirm/alert/prompt in this app — they fail
 * silently under Tauri's macOS private API. Use this or plugin-dialog `ask()`.
 */
export default function Dialog({
  onClose,
  alert = false,
  label,
  labelledBy,
  dismissible = true,
  className = "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4",
  panelClassName,
  children,
}: {
  onClose: () => void;
  /** Use role="alertdialog" instead of role="dialog". */
  alert?: boolean;
  /** aria-label; use `labelledBy` instead when a visible title exists. */
  label?: string;
  /** id of the visible title element, wired to aria-labelledby. */
  labelledBy?: string;
  /** When false, Escape and backdrop clicks do not close (busy states). */
  dismissible?: boolean;
  /** Backdrop/overlay classes. */
  className?: string;
  /** Panel classes. */
  panelClassName?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);

  useEffect(() => {
    if (!dismissible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [dismissible, onClose]);

  return (
    <div className={className} onClick={dismissible ? onClose : undefined}>
      <div
        ref={panelRef}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={panelClassName}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

import {
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

/** Props to spread onto the element that opens/closes the menu. */
export type MenuTriggerProps = {
  ref: RefObject<HTMLButtonElement | null>;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  onClick: () => void;
};

/**
 * Shared dismiss behavior for dropdowns/popovers: while `open`,
 * - Escape closes and returns focus to the trigger, and
 * - a pointer-down outside `containerRef` closes (no invisible backdrop div).
 *
 * Use directly when a component needs a custom layout (e.g. split buttons);
 * otherwise prefer the `Menu` component below.
 */
export function useMenuDismiss({
  open,
  onClose,
  containerRef,
  triggerRef,
}: {
  open: boolean;
  onClose: () => void;
  containerRef: RefObject<HTMLElement | null>;
  triggerRef?: RefObject<HTMLElement | null>;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
      triggerRef?.current?.focus();
    };
    const onPointerDown = (e: MouseEvent) => {
      const container = containerRef.current;
      if (container && !container.contains(e.target as Node)) onClose();
    };
    // Capture phase so the menu's Escape wins over window-level handlers
    // (e.g. panels that close themselves on Escape).
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, onClose, containerRef, triggerRef]);
}

/**
 * Minimal accessible dropdown primitive. Controlled: the caller owns `open`.
 * The trigger render-prop receives ref + aria props to spread on its button;
 * `children` (the popover content) renders only while open, positioned by the
 * caller's own Tailwind classes inside the relative wrapper.
 */
export default function Menu({
  open,
  onOpenChange,
  className = "relative",
  renderTrigger,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Wrapper class; defaults to "relative" so absolute menus anchor to it. */
  className?: string;
  renderTrigger: (props: MenuTriggerProps) => ReactNode;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useMenuDismiss({
    open,
    onClose: () => onOpenChange(false),
    containerRef,
    triggerRef,
  });

  return (
    <div ref={containerRef} className={className}>
      {renderTrigger({
        ref: triggerRef,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: () => onOpenChange(!open),
      })}
      {open ? children : null}
    </div>
  );
}

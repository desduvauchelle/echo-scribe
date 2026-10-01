import { createElement, type HTMLAttributes, type Ref } from "react";
import { tailClass, tailStyle, type BubbleTail } from "../lib/bubbleTail";
import "../styles/speech-bubble.css";

type Props = HTMLAttributes<HTMLElement> & {
  as?: "aside" | "section" | "div";
  ref?: Ref<HTMLElement>;
  tail?: BubbleTail;
  variant?: "card" | "pill";
};

/** Shared floating surface; only native pet placement may opt into a pointer. */
export function BubbleSurface({ as: Tag = "section", tail = { side: "none", x: 0 },
  variant = "card", className = "", style, ...props }: Props) {
  return createElement(Tag, { ...props,
    className: `bubble-surface bubble-surface-${variant} ${className}${tailClass(tail)}`,
    style: { ...tailStyle(tail), ...style },
  });
}

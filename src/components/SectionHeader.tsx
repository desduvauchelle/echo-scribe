import type { ReactNode } from "react";

type Props = {
  /** Small uppercase label above the title. */
  eyebrow: ReactNode;
  title?: ReactNode;
  /** id on the title (or eyebrow when there is no title) for aria-labelledby. */
  headingId?: string;
  /** Right-aligned controls. */
  actions?: ReactNode;
  className?: string;
};

/** Dashboard section header: accent eyebrow, optional title, actions on the
 *  right. Mirrors the Focus board header so every section reads the same. */
export default function SectionHeader({ eyebrow, title, headingId, actions, className = "" }: Props) {
  return (
    <div className={`mb-2 flex items-end justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <p
          id={title ? undefined : headingId}
          className="text-[10px] font-semibold uppercase tracking-[0.13em] text-accent"
        >
          {eyebrow}
        </p>
        {title ? (
          <h2 id={headingId} className="mt-0.5 truncate text-[14px] font-semibold text-fg">
            {title}
          </h2>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

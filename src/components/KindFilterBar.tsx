import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckSquare,
  LayoutGrid,
  Mic,
  Phone,
  StickyNote,
  Video,
  type LucideIcon,
} from "lucide-react";
import type { ItemKind } from "../lib/api";

export type KindFilter = "all" | ItemKind | "recording";

const FILTERS: [KindFilter, string, LucideIcon][] = [
  ["all", "dashboard.filters.all", LayoutGrid],
  ["transcription", "dashboard.filters.transcriptions", Mic],
  ["note", "dashboard.filters.notes", StickyNote],
  ["task", "dashboard.filters.tasks", CheckSquare],
  ["meeting", "dashboard.filters.meetings", Phone],
  ["recording", "dashboard.filters.recordings", Video],
];

type Props = {
  value: KindFilter;
  onChange: (value: KindFilter) => void;
  /** Filters to leave out (e.g. recordings on a project page — they have no project). */
  hide?: KindFilter[];
  /** Right-aligned toolbar content. */
  children?: ReactNode;
};

/** The dashboard's kind filter toolbar, shared by every activity feed. */
export default function KindFilterBar({ value, onChange, hide = [], children }: Props) {
  const { t } = useTranslation("main");
  return (
    <div className="echo-filter-toolbar flex items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-0.5">
        {FILTERS.filter(([v]) => !hide.includes(v)).map(([v, labelKey, Icon]) => {
          const active = v === value;
          return (
            <button
              key={v}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(v)}
              className={`material-filter flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] ${
                active ? "is-active" : "text-muted hover:text-fg"
              }`}
            >
              <Icon size={12} strokeWidth={2} />
              {t(labelKey)}
            </button>
          );
        })}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-1">{children}</div> : null}
    </div>
  );
}

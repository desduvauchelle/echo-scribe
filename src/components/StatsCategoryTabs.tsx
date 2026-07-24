import {
  CheckSquare2,
  Mic,
  Phone,
  StickyNote,
  Video,
  type LucideIcon,
} from "lucide-react";
import type { StatsCategoryKey } from "../lib/api";

export const STATS_CATEGORIES: Array<{
  key: StatsCategoryKey;
  label: string;
  singular: string;
  icon: LucideIcon;
}> = [
  { key: "transcriptions", label: "Transcriptions", singular: "transcription", icon: Mic },
  { key: "notes", label: "Notes", singular: "note", icon: StickyNote },
  { key: "tasks", label: "Tasks", singular: "task", icon: CheckSquare2 },
  { key: "meetings", label: "Meetings", singular: "meeting", icon: Phone },
  { key: "recordings", label: "Recordings", singular: "recording", icon: Video },
];

export function StatsCategoryTabs({
  value,
  onChange,
  compact = false,
}: {
  value: StatsCategoryKey;
  onChange: (value: StatsCategoryKey) => void;
  compact?: boolean;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      role="tablist"
      aria-label="Activity type"
    >
      {STATS_CATEGORIES.map(({ key, label, icon: Icon }) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={(event) => {
              event.stopPropagation();
              onChange(key);
            }}
            className={`flex items-center gap-1.5 rounded-md transition-colors ${
              compact ? "px-2 py-1 text-[11px]" : "px-3 py-1.5 text-xs"
            } ${
              active
                ? "bg-accent-soft font-medium text-accent"
                : "text-muted hover:bg-elevated hover:text-fg"
            }`}
          >
            <Icon size={compact ? 11 : 13} strokeWidth={2} aria-hidden="true" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function categoryMeta(key: StatsCategoryKey) {
  return STATS_CATEGORIES.find((category) => category.key === key) ?? STATS_CATEGORIES[0];
}

export function formatDuration(durationMs: number): string {
  const minutes = Math.round(durationMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

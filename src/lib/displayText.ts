// Translation-aware wrappers around the pure display helpers in ./format and
// ./meetingStatus.
//
// Those two modules are imported by `tests/` (bun, no DOM), so they must stay
// free of `src/i18n.ts` — it touches window/navigator/localStorage at import
// time. The split keeps the bucketing/branching logic testable while the copy
// lives in the catalogs: nothing here imports i18n either, the caller's `t`
// is passed in from a component that already holds `useTranslation()`.

import type { JsBinding, MeetingStatus } from "./api";
import { formatBinding, type KeyLabels } from "./binding";
import { relativeTimeParts } from "./format";

/** Minimal structural shape of i18next's `t`. Narrower than `TFunction` on
 *  purpose: these helpers only ever do dynamic string keys with an options
 *  bag, which the full overload set doesn't accept cleanly. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** "5 min ago" / "Just now", localized. Falls back to the raw ISO string when
 *  the timestamp can't be parsed, matching the old lib behaviour. */
export function relativeTimeLabel(
  t: Translate,
  iso: string,
  nowMs = Date.now(),
): string {
  const parts = relativeTimeParts(iso, nowMs);
  if (!parts) return iso;
  if (parts.unit === "justNow") return t("common:relativeTime.justNow");
  return t(`common:relativeTime.${parts.unit}`, { count: parts.count });
}

/** Short status word for a meeting ("Transcribing…"). Empty for `complete`,
 *  which renders no status word — mirrors `meetingStatusDisplay().label`. */
export function meetingStatusLabel(t: Translate, status: MeetingStatus): string {
  if (status === "complete") return "";
  return t(`common:meetingStatus.${status}.label`);
}

/** Banner/tooltip sentence for a meeting status. Empty for `complete`. */
export function meetingStatusDescription(
  t: Translate,
  status: MeetingStatus,
): string {
  if (status === "complete") return "";
  return t(`common:meetingStatus.${status}.description`);
}

/** Build a translated `KeyLabels` for ./binding from a component's `t`.
 *  Keys are namespaced explicitly so this works from any namespace — the
 *  hotkey display in views/Main.tsx holds a `main`-bound `t`. */
export function keyLabels(t: Translate): KeyLabels {
  return {
    control: t("common:keyNames.control"),
    shift: t("common:keyNames.shift"),
    option: t("common:keyNames.option"),
    command: t("common:keyNames.command"),
    space: t("common:keyNames.space"),
    enter: t("common:keyNames.enter"),
    tab: t("common:keyNames.tab"),
    escape: t("common:keyNames.escape"),
    backspace: t("common:keyNames.backspace"),
    del: t("common:keyNames.delete"),
    capsLock: t("common:keyNames.capsLock"),
    home: t("common:keyNames.home"),
    end: t("common:keyNames.end"),
    pageUp: t("common:keyNames.pageUp"),
    pageDown: t("common:keyNames.pageDown"),
    numpad: (digit) => t("common:keyNames.numpad", { digit }),
    side: (side, key) =>
      side === "Left"
        ? t("common:keyNames.leftSide", { key })
        : t("common:keyNames.rightSide", { key }),
  };
}

/** A hotkey binding rendered with localized key names ("Umschalt links + L"). */
export function formatBindingLabel(t: Translate, b: JsBinding): string {
  return formatBinding(b, keyLabels(t));
}

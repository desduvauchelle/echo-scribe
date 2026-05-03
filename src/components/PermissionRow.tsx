import { CheckCircle2, CircleAlert } from "lucide-react";

type Props = {
  title: string;
  subtitle: string;
  granted: boolean;
  onGrant: () => void;
  onRecheck: () => void;
  recheckBusy: boolean;
};

export function StatusPill({ granted }: { granted: boolean }) {
  return granted ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
      <CheckCircle2 size={11} strokeWidth={2.25} />
      Granted
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
      <CircleAlert size={11} strokeWidth={2.25} />
      Not granted
    </span>
  );
}

export default function PermissionRow(props: Props) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold tracking-tight text-fg">
          {props.title}
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          {props.subtitle}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <StatusPill granted={props.granted} />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={props.onGrant}
            className="cursor-pointer rounded-md border border-line px-3 py-1 text-xs text-muted transition-colors hover:bg-elevated hover:text-fg"
          >
            Grant access
          </button>
          <button
            type="button"
            onClick={props.onRecheck}
            disabled={props.recheckBusy}
            className="cursor-pointer rounded-md border border-line px-3 py-1 text-xs text-muted transition-colors hover:bg-elevated hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {props.recheckBusy ? "…" : "Re-check"}
          </button>
        </div>
      </div>
    </div>
  );
}

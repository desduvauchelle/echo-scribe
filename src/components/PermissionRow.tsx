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
    <span className="inline-flex items-center rounded-full bg-emerald-900 px-2 py-0.5 text-xs text-emerald-200">
      Granted
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-amber-900 px-2 py-0.5 text-xs text-amber-200">
      Not granted
    </span>
  );
}

export default function PermissionRow(props: Props) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 flex-1">
        <div className="font-semibold tracking-tight">{props.title}</div>
        <p className="mt-1 text-sm text-neutral-300">{props.subtitle}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <StatusPill granted={props.granted} />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={props.onGrant}
            className="rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800"
          >
            Grant access
          </button>
          <button
            type="button"
            onClick={props.onRecheck}
            disabled={props.recheckBusy}
            className="rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800 disabled:opacity-50"
          >
            {props.recheckBusy ? "…" : "Re-check"}
          </button>
        </div>
      </div>
    </div>
  );
}

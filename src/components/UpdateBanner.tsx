import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ArrowDownToLine, X } from "lucide-react";
import { applyUpdateAndRestart, dismissUpdate } from "../lib/api";

type UpdateInfo = {
  version: string;
};

export default function UpdateBanner() {
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen<UpdateInfo>("update-ready", (event) => {
        setUpdateVersion(event.payload.version);
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  if (!updateVersion) return null;

  const handleRestart = async () => {
    await applyUpdateAndRestart();
  };

  const handleDismiss = async () => {
    setUpdateVersion(null);
    await dismissUpdate(updateVersion);
  };

  return (
    <div className="flex items-center justify-between gap-3 border-b border-accent/40 bg-accent-soft px-4 py-2 text-xs text-accent">
      <span className="inline-flex items-center gap-1.5">
        <ArrowDownToLine size={12} strokeWidth={2} />
        Echo Scribe {updateVersion} is ready
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleRestart}
          className="shrink-0 cursor-pointer rounded-md border border-accent/50 bg-accent/15 px-2.5 py-0.5 font-semibold text-accent transition-colors hover:bg-accent/25"
        >
          Restart Now
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="shrink-0 cursor-pointer rounded p-0.5 text-accent/70 transition-colors hover:bg-accent/15 hover:text-accent"
          aria-label="Dismiss update"
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

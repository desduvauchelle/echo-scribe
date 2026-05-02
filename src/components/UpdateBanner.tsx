import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
    <div className="flex items-center justify-between gap-3 border-b border-blue-900/60 bg-blue-950/40 px-4 py-2 text-xs text-blue-100">
      <span>
        ↑ Echo Scribe {updateVersion} is ready
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleRestart}
          className="shrink-0 rounded border border-blue-700 bg-blue-900/50 px-2 py-0.5 font-semibold text-blue-100 hover:bg-blue-900/70"
        >
          Restart Now
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="shrink-0 text-blue-400 hover:text-blue-200"
          aria-label="Dismiss update"
        >
          ×
        </button>
      </div>
    </div>
  );
}

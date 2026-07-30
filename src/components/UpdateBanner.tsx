import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ArrowDownToLine, X } from "lucide-react";
import { applyUpdateAndRestart, dismissUpdate } from "../lib/api";
import { useCapabilities } from "../lib/capabilitiesContext";
import { uiGates } from "../lib/capabilities";

type UpdateInfo = {
  version: string;
};

type Props = {
  /**
   * "floating" (default): bottom-left card for views without a sidebar
   * (onboarding, settings). "sidebar": compact card slotted above the
   * Settings button in Main's sidebar. Never a top bar — the top 2rem is
   * the tauri drag region and overlaps the macOS traffic lights.
   */
  variant?: "floating" | "sidebar";
};

export default function UpdateBanner({ variant = "floating" }: Props) {
  const caps = useCapabilities();
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

  if (!uiGates(caps).showSelfUpdate) return null;
  if (!updateVersion) return null;

  const handleRestart = async () => {
    await applyUpdateAndRestart();
  };

  const handleDismiss = async () => {
    setUpdateVersion(null);
    await dismissUpdate(updateVersion);
  };

  if (variant === "sidebar") {
    return (
      <div
        role="status"
        className="material-status-card relative border border-line p-2.5 text-xs text-accent"
      >
        <button
          type="button"
          onClick={handleDismiss}
          className="absolute right-1.5 top-1.5 cursor-pointer rounded p-0.5 text-accent/70 transition-colors hover:bg-accent/15 hover:text-accent"
          aria-label="Dismiss update"
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
        <span className="inline-flex items-center gap-1.5 pr-5 font-semibold">
          <ArrowDownToLine size={12} strokeWidth={2} aria-hidden="true" />
          Update ready
        </span>
        <div className="mt-0.5 text-[11px] text-accent/80">
          Echo Scribe {updateVersion}
        </div>
        <button
          type="button"
          onClick={handleRestart}
          className="mt-2 w-full cursor-pointer rounded-md border border-accent/50 bg-accent/15 px-2.5 py-1 font-semibold text-accent transition-colors hover:bg-accent/25"
        >
          Restart Now
        </button>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 flex max-w-sm items-center gap-3 rounded-md border border-accent/40 bg-surface px-3 py-2.5 text-xs shadow-lg shadow-black/40"
    >
      <span className="inline-flex items-center gap-1.5 text-accent">
        <ArrowDownToLine size={12} strokeWidth={2} aria-hidden="true" />
        Echo Scribe {updateVersion} is ready
      </span>
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
        <X size={12} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

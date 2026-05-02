import { useEffect, useState } from "react";
import { getVoiceAtCursorBinding, type JsBinding } from "../lib/api";
import { formatBinding } from "../lib/binding";

type Props = {
  onOpenSettings: () => void;
};

export default function Main({ onOpenSettings }: Props) {
  const [binding, setBinding] = useState<JsBinding | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await getVoiceAtCursorBinding();
        if (!cancelled) setBinding(b);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-full items-center justify-center bg-neutral-950 px-6 py-12 text-neutral-100">
      <div className="relative w-full max-w-[480px] rounded-xl border border-neutral-800 bg-neutral-900 p-8 text-center shadow-xl">
        <button
          type="button"
          onClick={onOpenSettings}
          className="absolute right-3 top-3 rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
        >
          Settings
        </button>

        <h1 className="text-2xl font-semibold tracking-tight">Echo Scribe</h1>
        <p className="mt-3 text-sm text-neutral-300">
          {binding
            ? `Hold ${formatBinding(binding)} to dictate`
            : error
              ? `Couldn’t load shortcut: ${error}`
              : "Loading shortcut…"}
        </p>
      </div>
    </div>
  );
}

import HotkeyRebinder from "../components/HotkeyRebinder";
import SpeechModelPicker from "../components/SpeechModelPicker";

type Props = {
  onBack: () => void;
};

export default function Settings({ onBack }: Props) {
  return (
    <div className="flex min-h-full items-start justify-center bg-neutral-950 px-6 py-12 text-neutral-100">
      <div className="relative w-full max-w-[480px] rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        <button
          type="button"
          onClick={onBack}
          className="mb-4 rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
        >
          ← Back
        </button>

        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>

        <section className="mt-6">
          <h2 className="text-sm font-semibold tracking-tight text-neutral-200">
            Speech model
          </h2>
          <p className="mt-1 text-sm text-neutral-300">
            Switch between downloaded models or download a new one.
          </p>

          <div className="mt-4">
            <SpeechModelPicker />
          </div>
        </section>

        <section className="mt-8">
          <h2 className="text-sm font-semibold tracking-tight text-neutral-200">
            Voice-at-cursor hotkey
          </h2>
          <p className="mt-1 text-sm text-neutral-300">
            Hold this key combination anywhere in macOS to dictate at the
            cursor.
          </p>

          <div className="mt-4">
            <HotkeyRebinder />
          </div>
        </section>
      </div>
    </div>
  );
}

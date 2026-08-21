import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { frontendLog } from "../lib/api";

type Props = {
  /** Current section kind — an error resets when the user navigates away. */
  section: string;
  onBackToDashboard: () => void;
  children: ReactNode;
};

type State = { error: Error | null };

/**
 * Fallback UI shown when a section crashes. Pulled out into its own function
 * component (rather than inlined in the class's render()) purely so it can
 * call the useTranslation() hook — hooks aren't usable inside class components.
 */
function ErrorFallback({ onBackToDashboard }: { onBackToDashboard: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm">
      <p className="text-danger">{t("sectionErrorBoundary.message")}</p>
      <button
        type="button"
        onClick={onBackToDashboard}
        className="rounded-md border border-line bg-surface px-3 py-1.5 text-muted hover:bg-elevated hover:text-fg"
      >
        {t("sectionErrorBoundary.backToDashboard")}
      </button>
    </div>
  );
}

/**
 * Catches render crashes inside the main content area so a broken section
 * can't blank the whole window. The shell (sidebar, toolbar) stays alive,
 * the user always has a way back to the dashboard, and the real error goes
 * to the daily log (target: "frontend").
 */
export default class SectionErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    frontendLog(
      "error",
      `section "${this.props.section}" crashed: ${error.message}\n${error.stack ?? ""}\ncomponent stack:${info.componentStack ?? ""}`,
    );
  }

  componentDidUpdate(prev: Props) {
    if (prev.section !== this.props.section && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorFallback
          onBackToDashboard={() => {
            this.setState({ error: null });
            this.props.onBackToDashboard();
          }}
        />
      );
    }
    return this.props.children;
  }
}

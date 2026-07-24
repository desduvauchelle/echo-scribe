import { useCallback, useState } from "react";
import { checkForUpdate } from "./api";
import { useToasts } from "../components/ToastProvider";

/**
 * Shared "Check for Updates" flow behind both the app menu item
 * (App listens for the `menu:check-updates` event) and the Settings button.
 * Runs the backend check and surfaces the outcome as a toast. Errors are
 * already friendly strings from the backend (raw detail stays in the logs).
 */
export function useUpdateCheck() {
  const toasts = useToasts();
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const res = await checkForUpdate();
      if (res.status === "up-to-date") {
        toasts.push({
          tone: "success",
          message: `You're up to date — Echo Scribe ${res.version} is the latest version.`,
        });
      } else if (res.status === "downloading") {
        toasts.push({
          tone: "info",
          message: `Downloading Echo Scribe ${res.version}… you'll be asked to restart once it's ready.`,
        });
      } else {
        toasts.push({ tone: "error", message: res.message });
      }
    } catch {
      toasts.push({
        tone: "error",
        message:
          "Update check failed. See Settings → Diagnostics → logs for details.",
      });
    } finally {
      setChecking(false);
    }
  }, [toasts]);

  return { check, checking };
}

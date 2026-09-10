import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useToasts } from "./ToastProvider";
import {
  getMcpSettings,
  installMcpForAgent,
  type McpInstallAgent,
} from "../lib/api";
import { mcpInstallSnippets } from "../lib/mcpInstall";

// Same fallback the Settings page uses when the backend can't report its own
// executable path — the copy snippet still shows a working install line.
const DEFAULT_MCP_BINARY_PATH =
  "/Applications/Tucky.app/Contents/MacOS/echo-scribe";

/** Optional onboarding card that surfaces the built-in MCP server so a user
 *  can hook Tucky to Claude Code / Codex / Cursor / any MCP-capable client
 *  (ChatGPT Desktop, Windsurf, Gemini CLI) at first-run instead of hunting
 *  through Settings → Coding Agents. Deliberately non-blocking: Start Tucky
 *  stays enabled regardless of what happens here. */
export default function OnboardingMcpCard() {
  const { t } = useTranslation("onboarding");
  const [binaryPath, setBinaryPath] = useState(DEFAULT_MCP_BINARY_PATH);

  useEffect(() => {
    let cancelled = false;
    getMcpSettings()
      .then((s) => {
        if (!cancelled && s?.binary_path) setBinaryPath(s.binary_path);
      })
      .catch(() => {
        // Fallback path still lets the user copy a working snippet.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const snippets = mcpInstallSnippets(binaryPath);

  return (
    <div className="rounded-lg border border-line bg-canvas p-4">
      <div className="text-sm font-semibold text-fg">
        {t("mcpConnect.title")}
      </div>
      <p className="mt-0.5 text-xs leading-relaxed text-muted">
        {t("mcpConnect.subtitle")}
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <McpRow
          title={t("mcpConnect.claudeCode.title")}
          hint={t("mcpConnect.claudeCode.hint")}
          text={snippets.claudeCode}
          installAgent="claude-code"
        />
        <McpRow
          title={t("mcpConnect.codex.title")}
          hint={t("mcpConnect.codex.hint")}
          text={snippets.codexToml}
          installAgent="codex"
        />
        <McpRow
          title={t("mcpConnect.other.title")}
          hint={t("mcpConnect.other.hint")}
          text={snippets.genericJson}
        />
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-faint">
        {t("mcpConnect.skipHint")}
      </p>
    </div>
  );
}

function McpRow({
  title,
  hint,
  text,
  installAgent,
}: {
  title: string;
  hint: string;
  text: string;
  installAgent?: McpInstallAgent;
}) {
  const { t } = useTranslation("onboarding");
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);
  const toasts = useToasts();

  const onInstall = async (agent: McpInstallAgent) => {
    setInstalling(true);
    try {
      const message = await installMcpForAgent(agent);
      toasts.push({ tone: "success", message });
    } catch (e) {
      // installMcpForAgent already rejects with a short human message when the
      // CLI is missing or refuses; the raw stderr stays in the daily log under
      // target: "mcp" from mcp_install.rs.
      toasts.push({
        tone: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="rounded-md border border-line bg-surface p-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-fg">{title}</div>
          <p className="text-[11px] leading-relaxed text-muted">{hint}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {installAgent && (
            <button
              type="button"
              onClick={() => void onInstall(installAgent)}
              disabled={installing}
              className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-canvas disabled:cursor-not-allowed disabled:opacity-60"
            >
              {installing
                ? t("mcpConnect.installing")
                : t("mcpConnect.installButton")}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
            aria-label={t("mcpConnect.copyAriaLabel", { title })}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors hover:bg-elevated ${
              copied
                ? "border-green-500/40 text-green-500"
                : "border-line text-fg"
            }`}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? t("mcpConnect.copied") : t("mcpConnect.copyButton")}
          </button>
        </div>
      </div>
    </div>
  );
}

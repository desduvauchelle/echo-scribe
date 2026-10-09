import { useEffect, useState } from "react";
import { gmailStatus, gmailImportClient, gmailConnect, gmailDisconnect, gmailOpenAssistant, type GmailAccount } from "../lib/api";

export default function GmailSettings() {
  const [accounts, setAccounts] = useState<GmailAccount[]>([]);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => { const status = await gmailStatus(); setAccounts(status.accounts); setConfigured(status.configured); };
  useEffect(() => { void refresh().catch((e) => setError(String(e))); }, []);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); await refresh(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <div className="max-w-xl space-y-5 text-sm">
    <p className="text-muted">Ask Tucky to search your Gmail conversations, use them as context, and prepare replies. Review each email in a separate window before saving or sending.</p>
    {error && <p role="alert" className="rounded-md border border-danger p-3 text-danger">{error}</p>}
    {!configured && <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
      <h2 className="font-semibold">Connect Gmail</h2>
      <p className="text-xs leading-relaxed text-muted">First, import a Google Desktop app OAuth client. You can create one in the same Google Cloud project used by Tamias. Enable Gmail API and add your Gmail accounts as test users.</p>
      <button disabled={busy} onClick={() => void perform(gmailImportClient)} className="rounded-md bg-accent px-3 py-2 font-medium text-canvas disabled:opacity-50">Import Google OAuth JSON…</button>
    </section>}
    {accounts.map((a) => <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-4">
      <div><p className="break-all font-medium">{a.email}</p><p className="mt-1 text-xs text-muted">Connected for search, drafts, and sending</p></div>
      <button disabled={busy} onClick={() => void perform(() => gmailDisconnect(a.id))} className="rounded-md border border-line px-3 py-2 text-xs disabled:opacity-50">Disconnect</button>
    </div>)}
    {configured && <div className="flex flex-wrap gap-3">
      <button disabled={busy} onClick={() => void perform(gmailConnect)} className="rounded-md bg-accent px-3 py-2 font-medium text-canvas disabled:opacity-50">{busy ? "Connecting…" : accounts.length ? "Connect another Gmail account" : "Connect Gmail account"}</button>
      {accounts.length > 0 && <button disabled={busy} onClick={() => void perform(gmailOpenAssistant)} className="rounded-md border border-line px-3 py-2">Ask Tucky about email</button>}
    </div>}
    <p className="text-xs leading-relaxed text-muted">Credentials stay in macOS Keychain. Emails are searched on demand. Review drafts and the email they reply to are saved locally. Disconnecting removes that account’s local drafts and credentials.</p>
    {configured && <details className="text-xs text-muted"><summary className="cursor-pointer">Google app setup</summary><div className="mt-3 space-y-3">
      <p>Use a Desktop app client, rather than Tamias’s Web application client. Grant both Gmail read and draft/send access during Google sign-in. Testing-mode grants can expire and need reconnection.</p>
      <button disabled={busy} onClick={() => void perform(gmailImportClient)} className="rounded-md border border-line px-3 py-2">Replace OAuth client JSON…</button>
    </div></details>}
  </div>;
}

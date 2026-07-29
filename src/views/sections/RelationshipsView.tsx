import { useEffect, useMemo, useState } from "react";
import { Building2, Copy, Loader, Plus, Sparkles, UserRound } from "lucide-react";
import Markdown from "../../components/Markdown";
import {
  generateMeetingArtifact,
  listCompanies,
  listPeople,
  listRelationshipMeetings,
  saveCompany,
  savePerson,
  type Company,
  type MeetingArtifact,
  type MeetingRow,
  type Person,
} from "../../lib/api";

type Selection = { kind: "person"; value: Person } | { kind: "company"; value: Company };

export default function RelationshipsView() {
  const [people, setPeople] = useState<Person[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [artifact, setArtifact] = useState<MeetingArtifact | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<"person" | "company" | null>(null);
  const [name, setName] = useState("");
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const companyMap = useMemo(() => new Map(companies.map((company) => [company.id, company])), [companies]);
  const refresh = async () => {
    const [nextPeople, nextCompanies] = await Promise.all([listPeople(), listCompanies()]);
    setPeople(nextPeople);
    setCompanies(nextCompanies);
  };
  useEffect(() => { void refresh().catch((e) => setError(String(e))); }, []);

  useEffect(() => {
    if (!selection) { setMeetings([]); return; }
    setArtifact(null);
    listRelationshipMeetings(selection.kind, selection.value.id).then(setMeetings).catch((e) => setError(String(e)));
  }, [selection]);

  const create = async () => {
    if (!creating || !name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      if (creating === "person") {
        const person = await savePerson({ name, role: detail || null, notes: "" });
        await refresh();
        setSelection({ kind: "person", value: person });
      } else {
        const company = await saveCompany({ name, domain: detail || null, notes: "" });
        await refresh();
        setSelection({ kind: "company", value: company });
      }
      setCreating(null); setName(""); setDetail("");
    } catch (e) { setError(String(e)); } finally { setLoading(false); }
  };

  const prep = async () => {
    if (!selection) return;
    setLoading(true); setError(null);
    try { setArtifact(await generateMeetingArtifact("prep_brief", selection.kind, selection.value.id)); }
    catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  };

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-line bg-surface/50 p-4">
        <div className="mb-4 flex items-center justify-between">
          <div><h1 className="text-base font-semibold text-fg">Relationships</h1><p className="text-[11px] text-faint">Local people and company memory</p></div>
          <div className="flex gap-1">
            <button onClick={() => setCreating("person")} className="rounded p-1.5 text-muted hover:bg-elevated hover:text-accent" title="Add person"><UserRound size={14} /></button>
            <button onClick={() => setCreating("company")} className="rounded p-1.5 text-muted hover:bg-elevated hover:text-accent" title="Add company"><Building2 size={14} /></button>
          </div>
        </div>
        {creating ? (
          <div className="mb-4 space-y-2 rounded-lg border border-line bg-canvas p-2.5">
            <div className="flex items-center gap-1 text-[11px] font-medium text-fg"><Plus size={12} /> New {creating}</div>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="w-full rounded border border-line bg-surface px-2 py-1.5 text-xs text-fg" />
            <input value={detail} onChange={(e) => setDetail(e.target.value)} placeholder={creating === "person" ? "Role (optional)" : "Domain (optional)"} className="w-full rounded border border-line bg-surface px-2 py-1.5 text-xs text-fg" />
            <div className="flex justify-end gap-1"><button onClick={() => setCreating(null)} className="px-2 py-1 text-[11px] text-muted">Cancel</button><button onClick={() => void create()} disabled={!name.trim() || loading} className="rounded bg-accent px-2 py-1 text-[11px] text-white disabled:opacity-50">Create</button></div>
          </div>
        ) : null}
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-faint">People</div>
        <div className="space-y-1">
          {people.map((person) => <button key={person.id} onClick={() => setSelection({ kind: "person", value: person })} className={`w-full rounded-md px-2 py-2 text-left ${selection?.kind === "person" && selection.value.id === person.id ? "bg-accent-soft" : "hover:bg-elevated"}`}><div className="text-xs font-medium text-fg">{person.name}</div><div className="text-[10px] text-faint">{person.role || (person.company_id ? companyMap.get(person.company_id)?.name : "No company")}</div></button>)}
          {people.length === 0 ? <div className="px-2 py-2 text-[11px] text-faint">Confirm a meeting speaker or add someone here.</div> : null}
        </div>
        <div className="mb-2 mt-4 text-[10px] font-medium uppercase tracking-wider text-faint">Companies</div>
        <div className="space-y-1">{companies.map((company) => <button key={company.id} onClick={() => setSelection({ kind: "company", value: company })} className={`w-full rounded-md px-2 py-2 text-left ${selection?.kind === "company" && selection.value.id === company.id ? "bg-accent-soft" : "hover:bg-elevated"}`}><div className="text-xs font-medium text-fg">{company.name}</div><div className="text-[10px] text-faint">{company.domain || "No domain"}</div></button>)}</div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        {!selection ? <div className="mx-auto mt-24 max-w-sm text-center"><UserRound className="mx-auto mb-3 text-faint" size={28} /><h2 className="text-sm font-medium text-fg">Select a relationship</h2><p className="mt-1 text-xs text-faint">See confirmed meeting history and create a manually launched Prep brief.</p></div> : (
          <div className="mx-auto max-w-3xl space-y-5">
            <div className="flex items-start justify-between"><div><div className="flex items-center gap-2">{selection.kind === "person" ? <UserRound size={18} className="text-accent" /> : <Building2 size={18} className="text-accent" />}<h2 className="text-xl font-semibold text-fg">{selection.value.name}</h2></div><p className="mt-1 text-xs text-muted">{selection.kind === "person" ? selection.value.role || selection.value.email || "Person" : selection.value.domain || "Company"}</p></div><button onClick={() => void prep()} disabled={loading || meetings.length === 0} className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-2 text-xs text-accent hover:bg-elevated disabled:opacity-50">{loading ? <Loader size={13} className="animate-spin" /> : <Sparkles size={13} />} Create Prep brief</button></div>
            <section><h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted">Meeting history</h3><div className="space-y-2">{meetings.map((meeting) => <div key={meeting.item_id} className="rounded-lg border border-line bg-surface p-3"><div className="text-xs font-medium text-fg">{meeting.detected_app_name ? `Meeting via ${meeting.detected_app_name}` : "Meeting"}</div><div className="mt-1 text-[10px] text-faint">{new Date(meeting.started_at).toLocaleString()} · {meeting.status}</div></div>)}{meetings.length === 0 ? <p className="text-xs text-faint">No confirmed meetings are linked yet.</p> : null}</div></section>
            {artifact ? <section className="rounded-lg border border-line bg-surface p-4"><div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-medium text-fg">{artifact.title}</h3><button onClick={() => navigator.clipboard.writeText(artifact.content)} className="rounded p-1 text-faint hover:text-accent" aria-label="Copy brief"><Copy size={13} /></button></div><div className="text-xs text-fg"><Markdown>{artifact.content}</Markdown></div></section> : null}
            {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
          </div>
        )}
      </main>
    </div>
  );
}

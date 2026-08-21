import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Building2,
  Copy,
  Loader,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import Dialog from "../../components/a11y/Dialog";
import Markdown from "../../components/Markdown";
import {
  deleteCompany,
  deletePerson,
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

type Selection =
  | { kind: "person"; value: Person }
  | { kind: "company"; value: Company };

export default function RelationshipsView() {
  const { t } = useTranslation("main");
  const [people, setPeople] = useState<Person[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [artifact, setArtifact] = useState<MeetingArtifact | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<"person" | "company" | null>(null);
  const [name, setName] = useState("");
  const [detail, setDetail] = useState("");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editDetail, setEditDetail] = useState("");
  const [editCompanyId, setEditCompanyId] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const companyMap = useMemo(
    () => new Map(companies.map((company) => [company.id, company])),
    [companies],
  );

  const refresh = async () => {
    const [nextPeople, nextCompanies] = await Promise.all([
      listPeople(),
      listCompanies(),
    ]);
    setPeople(nextPeople);
    setCompanies(nextCompanies);
  };

  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!selection) {
      setMeetings([]);
      return;
    }
    setArtifact(null);
    listRelationshipMeetings(selection.kind, selection.value.id)
      .then(setMeetings)
      .catch((e) => setError(String(e)));
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
      setCreating(null);
      setName("");
      setDetail("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const startEdit = () => {
    if (!selection) return;
    setError(null);
    setEditName(selection.value.name);
    setEditNotes(selection.value.notes);
    if (selection.kind === "person") {
      setEditEmail(selection.value.email ?? "");
      setEditDetail(selection.value.role ?? "");
      setEditCompanyId(selection.value.company_id ?? "");
    } else {
      setEditEmail("");
      setEditDetail(selection.value.domain ?? "");
      setEditCompanyId("");
    }
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!selection || !editName.trim()) return;
    setLoading(true);
    setError(null);
    try {
      if (selection.kind === "person") {
        const person = await savePerson({
          id: selection.value.id,
          name: editName,
          email: editEmail || null,
          role: editDetail || null,
          companyId: editCompanyId || null,
          notes: editNotes,
        });
        await refresh();
        setSelection({ kind: "person", value: person });
      } else {
        const company = await saveCompany({
          id: selection.value.id,
          name: editName,
          domain: editDetail || null,
          notes: editNotes,
        });
        await refresh();
        setSelection({ kind: "company", value: company });
      }
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setLoading(true);
    setError(null);
    try {
      if (deleteTarget.kind === "person") {
        await deletePerson(deleteTarget.value.id);
      } else {
        await deleteCompany(deleteTarget.value.id);
      }
      await refresh();
      setSelection(null);
      setEditing(false);
      setDeleteTarget(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const prep = async () => {
    if (!selection) return;
    setLoading(true);
    setError(null);
    try {
      setArtifact(
        await generateMeetingArtifact(
          "prep_brief",
          selection.kind,
          selection.value.id,
        ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-line bg-surface/50 p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-fg">{t("relationships.header.title")}</h1>
            <p className="text-[11px] text-faint">{t("relationships.header.subtitle")}</p>
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => setCreating("person")}
              className="rounded p-1.5 text-muted hover:bg-elevated hover:text-accent"
              title={t("relationships.actions.addPerson")}
            >
              <UserRound size={14} />
            </button>
            <button
              onClick={() => setCreating("company")}
              className="rounded p-1.5 text-muted hover:bg-elevated hover:text-accent"
              title={t("relationships.actions.addCompany")}
            >
              <Building2 size={14} />
            </button>
          </div>
        </div>

        {creating ? (
          <div className="mb-4 space-y-2 rounded-lg border border-line bg-canvas p-2.5">
            <div className="flex items-center gap-1 text-[11px] font-medium text-fg">
              <Plus size={12} /> {t("relationships.create.newLabel", {
                kind: creating === "person" ? t("relationships.kind.personLower") : t("relationships.kind.companyLower"),
              })}
            </div>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("relationships.form.name")}
              className="w-full rounded border border-line bg-surface px-2 py-1.5 text-xs text-fg"
            />
            <input
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder={creating === "person" ? t("relationships.create.rolePlaceholder") : t("relationships.create.domainPlaceholder")}
              className="w-full rounded border border-line bg-surface px-2 py-1.5 text-xs text-fg"
            />
            <div className="flex justify-end gap-1">
              <button onClick={() => setCreating(null)} className="px-2 py-1 text-[11px] text-muted">
                {t("relationships.common.cancel")}
              </button>
              <button
                onClick={() => void create()}
                disabled={!name.trim() || loading}
                className="rounded bg-accent px-2 py-1 text-[11px] text-white disabled:opacity-50"
              >
                {t("relationships.create.submit")}
              </button>
            </div>
          </div>
        ) : null}

        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-faint">{t("relationships.people.heading")}</div>
        <div className="space-y-1">
          {people.map((person) => (
            <button
              key={person.id}
              onClick={() => {
                setEditing(false);
                setSelection({ kind: "person", value: person });
              }}
              className={`w-full rounded-md px-2 py-2 text-left ${selection?.kind === "person" && selection.value.id === person.id ? "bg-accent-soft" : "hover:bg-elevated"}`}
            >
              <div className="text-xs font-medium text-fg">{person.name}</div>
              <div className="text-[10px] text-faint">
                {person.role || (person.company_id ? companyMap.get(person.company_id)?.name ?? t("relationships.people.noCompany") : t("relationships.people.noCompany"))}
              </div>
            </button>
          ))}
          {people.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-faint">{t("relationships.people.empty")}</div>
          ) : null}
        </div>

        <div className="mb-2 mt-4 text-[10px] font-medium uppercase tracking-wider text-faint">{t("relationships.companies.heading")}</div>
        <div className="space-y-1">
          {companies.map((company) => (
            <button
              key={company.id}
              onClick={() => {
                setEditing(false);
                setSelection({ kind: "company", value: company });
              }}
              className={`w-full rounded-md px-2 py-2 text-left ${selection?.kind === "company" && selection.value.id === company.id ? "bg-accent-soft" : "hover:bg-elevated"}`}
            >
              <div className="text-xs font-medium text-fg">{company.name}</div>
              <div className="text-[10px] text-faint">{company.domain || t("relationships.companies.noDomain")}</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        {!selection ? (
          <div className="mx-auto mt-24 max-w-sm text-center">
            <UserRound className="mx-auto mb-3 text-faint" size={28} />
            <h2 className="text-sm font-medium text-fg">{t("relationships.emptyState.title")}</h2>
            <p className="mt-1 text-xs text-faint">{t("relationships.emptyState.subtitle")}</p>
            {error ? <p role="alert" className="mt-3 text-xs text-danger">{error}</p> : null}
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  {selection.kind === "person" ? (
                    <UserRound size={18} className="text-accent" />
                  ) : (
                    <Building2 size={18} className="text-accent" />
                  )}
                  <h2 className="text-xl font-semibold text-fg">{selection.value.name}</h2>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {selection.kind === "person"
                    ? selection.value.role || selection.value.email || t("relationships.kind.personLabel")
                    : selection.value.domain || t("relationships.kind.companyLabel")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => void prep()}
                  disabled={loading || meetings.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-2 text-xs text-accent hover:bg-elevated disabled:opacity-50"
                >
                  {loading && !editing ? <Loader size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  {t("relationships.actions.createPrepBrief")}
                </button>
                <button
                  onClick={startEdit}
                  disabled={loading}
                  aria-label={selection.kind === "person" ? t("relationships.actions.editContactAria") : t("relationships.actions.editCompanyAria")}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-2 text-xs text-fg hover:bg-elevated disabled:opacity-50"
                >
                  <Pencil size={13} /> {t("relationships.actions.editButton")}
                </button>
                <button
                  onClick={() => setDeleteTarget(selection)}
                  disabled={loading}
                  aria-label={selection.kind === "person" ? t("relationships.actions.deleteContactAria") : t("relationships.actions.deleteCompanyAria")}
                  className="inline-flex items-center gap-1.5 rounded-md border border-danger/40 px-3 py-2 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
                >
                  <Trash2 size={13} /> {t("relationships.common.delete")}
                </button>
              </div>
            </div>

            {editing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveEdit();
                }}
                className="space-y-4 rounded-lg border border-line bg-surface p-4"
              >
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1 text-[11px] text-muted">
                    <span>{t("relationships.form.name")}</span>
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full rounded border border-line bg-canvas px-2.5 py-2 text-xs text-fg"
                    />
                  </label>
                  {selection.kind === "person" ? (
                    <label className="space-y-1 text-[11px] text-muted">
                      <span>{t("relationships.form.email")}</span>
                      <input
                        type="email"
                        value={editEmail}
                        onChange={(e) => setEditEmail(e.target.value)}
                        className="w-full rounded border border-line bg-canvas px-2.5 py-2 text-xs text-fg"
                      />
                    </label>
                  ) : null}
                  <label className="space-y-1 text-[11px] text-muted">
                    <span>{selection.kind === "person" ? t("relationships.form.role") : t("relationships.form.domain")}</span>
                    <input
                      value={editDetail}
                      onChange={(e) => setEditDetail(e.target.value)}
                      className="w-full rounded border border-line bg-canvas px-2.5 py-2 text-xs text-fg"
                    />
                  </label>
                  {selection.kind === "person" ? (
                    <label className="space-y-1 text-[11px] text-muted">
                      <span>{t("relationships.form.company")}</span>
                      <select
                        value={editCompanyId}
                        onChange={(e) => setEditCompanyId(e.target.value)}
                        className="w-full rounded border border-line bg-canvas px-2.5 py-2 text-xs text-fg"
                      >
                        <option value="">{t("relationships.people.noCompany")}</option>
                        {companies.map((company) => (
                          <option key={company.id} value={company.id}>{company.name}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
                <label className="block space-y-1 text-[11px] text-muted">
                  <span>{t("relationships.form.notes")}</span>
                  <textarea
                    rows={4}
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    className="w-full resize-y rounded border border-line bg-canvas px-2.5 py-2 text-xs text-fg"
                  />
                </label>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    disabled={loading}
                    className="rounded-md px-3 py-2 text-xs text-muted hover:bg-elevated disabled:opacity-50"
                  >
                    {t("relationships.common.cancel")}
                  </button>
                  <button
                    type="submit"
                    disabled={!editName.trim() || loading}
                    className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs text-white disabled:opacity-50"
                  >
                    {loading ? <Loader size={13} className="animate-spin" /> : null}
                    {t("relationships.form.saveChanges")}
                  </button>
                </div>
              </form>
            ) : null}

            <section>
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted">{t("relationships.meetings.heading")}</h3>
              <div className="space-y-2">
                {meetings.map((meeting) => (
                  <div key={meeting.item_id} className="rounded-lg border border-line bg-surface p-3">
                    <div className="text-xs font-medium text-fg">
                      {meeting.detected_app_name ? t("relationships.meetings.viaApp", { app: meeting.detected_app_name }) : t("relationships.meetings.fallback")}
                    </div>
                    <div className="mt-1 text-[10px] text-faint">
                      {new Date(meeting.started_at).toLocaleString()} · {meeting.status}
                    </div>
                  </div>
                ))}
                {meetings.length === 0 ? <p className="text-xs text-faint">{t("relationships.meetings.empty")}</p> : null}
              </div>
            </section>

            {artifact ? (
              <section className="rounded-lg border border-line bg-surface p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-fg">{artifact.title}</h3>
                  <button
                    onClick={() => navigator.clipboard.writeText(artifact.content)}
                    className="rounded p-1 text-faint hover:text-accent"
                    aria-label={t("relationships.artifact.copyAria")}
                  >
                    <Copy size={13} />
                  </button>
                </div>
                <div className="text-xs text-fg"><Markdown>{artifact.content}</Markdown></div>
              </section>
            ) : null}
            {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
          </div>
        )}
      </main>

      {deleteTarget ? (
        <Dialog
          alert
          labelledBy="delete-relationship-title"
          dismissible={!loading}
          onClose={() => setDeleteTarget(null)}
          panelClassName="w-full max-w-sm rounded-xl border border-line bg-surface p-5 shadow-2xl"
        >
          <h2 id="delete-relationship-title" className="text-base font-semibold text-fg">
            {t("relationships.deleteDialog.title", { name: deleteTarget.value.name })}
          </h2>
          <p className="mt-2 text-xs leading-5 text-muted">
            {t("relationships.deleteDialog.removesPrefix", { name: deleteTarget.value.name })}
            {deleteTarget.kind === "person" ? ` ${t("relationships.deleteDialog.personNote")}` : ` ${t("relationships.deleteDialog.companyNote")}`}
            {" "}{t("relationships.deleteDialog.cannotUndo")}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              disabled={loading}
              className="rounded-md px-3 py-2 text-xs text-muted hover:bg-elevated disabled:opacity-50"
            >
              {t("relationships.common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void confirmDelete()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-md bg-danger px-3 py-2 text-xs text-white disabled:opacity-50"
            >
              {loading ? <Loader size={13} className="animate-spin" /> : <Trash2 size={13} />}
              {t("relationships.common.delete")}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

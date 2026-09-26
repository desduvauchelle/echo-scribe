import type { Project, TaskWithItem } from "../lib/api";
import type { FeedEntry } from "../lib/feed";
import ItemCard from "./ItemCard";
import MeetingCard from "./MeetingCard";
import RecordingCard from "./RecordingCard";
import { FeedTaskRow } from "./TaskRow";

type Props = {
  entry: FeedEntry;
  projects: Map<string, Project>;
  /** Project whose pill is redundant here (its own project page). */
  hideProject?: Project | null;
  /** item id → task state; task items render as the Tasks-view row. */
  tasks?: Map<string, TaskWithItem>;
  /** Called after a task row is toggled or its deadline changes. */
  onTaskChanged?: () => void;
};

/** Shared dashboard-style rendering for activity entries. */
export default function ActivityLedgerEntry({
  entry,
  projects,
  hideProject,
  tasks,
  onTaskChanged,
}: Props) {
  if (entry.type === "meeting") {
    return (
      <MeetingCard
        mtg={entry.mtg}
        projects={projects}
        variant="ledger"
        hideProject={hideProject ? { id: hideProject.id, name: hideProject.name } : null}
      />
    );
  }

  if (entry.type === "recording") {
    return (
      <RecordingCard rec={entry.rec} projects={projects} variant="ledger" />
    );
  }

  if (entry.item.kind === "task") {
    return (
      <FeedTaskRow
        item={entry.item}
        task={tasks?.get(entry.item.id)}
        projects={projects}
        hideProjectId={hideProject?.id}
        onChanged={onTaskChanged}
      />
    );
  }

  return (
    <ItemCard
      item={entry.item}
      projects={projects}
      variant="ledger"
      hideProjectId={hideProject?.id}
    />
  );
}

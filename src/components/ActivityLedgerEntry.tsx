import type { Project } from "../lib/api";
import type { FeedEntry } from "../lib/feed";
import ItemCard from "./ItemCard";
import MeetingCard from "./MeetingCard";
import RecordingCard from "./RecordingCard";

type Props = {
  entry: FeedEntry;
  projects: Map<string, Project>;
};

/** Shared dashboard-style rendering for activity entries. */
export default function ActivityLedgerEntry({ entry, projects }: Props) {
  if (entry.type === "meeting") {
    return (
      <MeetingCard mtg={entry.mtg} projects={projects} variant="ledger" />
    );
  }

  if (entry.type === "recording") {
    return (
      <RecordingCard rec={entry.rec} projects={projects} variant="ledger" />
    );
  }

  return <ItemCard item={entry.item} projects={projects} variant="ledger" />;
}

import { useEffect, useMemo, useRef, useState } from "react";
import {
  searchItems,
  type Item,
  type Project,
} from "../../lib/api";
import ItemCard from "../../components/ItemCard";
import { useActivityPanel } from "../../components/ActivityPanelContext";
import { Search as SearchIcon, SearchX } from "lucide-react";
import { EmptyState, SkeletonList } from "./ActivityFeed";

type Props = {
  projects: Map<string, Project>;
};

export default function SearchView({ projects }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);
  const { refreshTick } = useActivityPanel();

  const runSearch = (trimmed: string) => {
    if (!trimmed) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await searchItems(trimmed);
        setResults(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  };

  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => runSearch(query.trim()), 200);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [query]);

  useEffect(() => {
    if (refreshTick === 0) return;
    runSearch(query.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const highlight = useMemo(
    () =>
      query
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0),
    [query],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line bg-canvas/40 px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight text-fg">Search</h1>
        <div className="relative mt-3">
          <SearchIcon
            size={14}
            strokeWidth={2}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your captures…"
            className="w-full rounded-md border border-line bg-canvas py-2 pl-9 pr-3 text-sm text-fg placeholder:text-faint transition-colors focus:border-accent focus:outline-none"
            autoFocus
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {error ? (
          <div className="mb-3 rounded-md border border-danger/40 bg-danger/15 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}

        {!query.trim() ? (
          <EmptyState
            icon={<SearchIcon size={20} strokeWidth={1.75} />}
            title="Type to search your captures."
            subtitle="Full-text search powered by SQLite FTS5."
          />
        ) : loading ? (
          <SkeletonList />
        ) : results.length === 0 ? (
          <EmptyState
            icon={<SearchX size={20} strokeWidth={1.75} />}
            title={`No results for "${query.trim()}"`}
            subtitle="Try a different keyword or simpler query."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {results.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                projects={projects}
                highlight={highlight}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

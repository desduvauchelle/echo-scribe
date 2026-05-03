import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteItem,
  restoreItem,
  searchItems,
  type Item,
  type Project,
} from "../../lib/api";
import ItemCard from "../../components/ItemCard";
import { Search as SearchIcon, SearchX } from "lucide-react";
import { EmptyState, SkeletonList } from "./ActivityFeed";
import { useToasts } from "../../components/ToastProvider";

type Props = {
  projects: Map<string, Project>;
};

export default function SearchView({ projects }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);
  const toasts = useToasts();

  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
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
    }, 200);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [query]);

  const highlight = useMemo(
    () =>
      query
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0),
    [query],
  );

  const onDelete = async (item: Item) => {
    setResults((prev) => prev.filter((i) => i.id !== item.id));
    try {
      await deleteItem(item.id);
      toasts.push({
        tone: "info",
        message: "Item deleted",
        action: {
          label: "Undo",
          onClick: () => {
            void (async () => {
              try {
                await restoreItem(item.id);
                // Re-run the current search.
                setQuery((q) => q);
              } catch (e) {
                toasts.push({
                  tone: "error",
                  message: `Restore failed: ${e instanceof Error ? e.message : String(e)}`,
                });
              }
            })();
          },
        },
      });
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Delete failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

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
                onDelete={() => void onDelete(item)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

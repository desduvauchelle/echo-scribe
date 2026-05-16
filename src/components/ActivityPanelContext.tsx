import { createContext, useCallback, useContext, useMemo, useState } from "react";

type Ctx = {
  selectedItemId: string | null;
  openItem: (id: string) => void;
  close: () => void;
  /** Bumps each time an item is saved through the panel. List views subscribe
   *  to it to invalidate their caches. */
  refreshTick: number;
  bumpRefresh: () => void;
};

const ActivityPanelCtx = createContext<Ctx | null>(null);

export function ActivityPanelProvider({ children }: { children: React.ReactNode }) {
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const openItem = useCallback((id: string) => setSelectedItemId(id), []);
  const close = useCallback(() => setSelectedItemId(null), []);
  const bumpRefresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  const value = useMemo<Ctx>(
    () => ({ selectedItemId, openItem, close, refreshTick, bumpRefresh }),
    [selectedItemId, openItem, close, refreshTick, bumpRefresh],
  );

  return (
    <ActivityPanelCtx.Provider value={value}>{children}</ActivityPanelCtx.Provider>
  );
}

export function useActivityPanel() {
  const ctx = useContext(ActivityPanelCtx);
  if (!ctx) throw new Error("useActivityPanel must be used inside ActivityPanelProvider");
  return ctx;
}

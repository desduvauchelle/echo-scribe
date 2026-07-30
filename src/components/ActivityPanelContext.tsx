import { createContext, useCallback, useContext, useMemo, useState } from "react";

type Ctx = {
  selectedItemId: string | null;
  openItem: (id: string) => void;
  evidenceTarget: { segmentIndex: number; nonce: number } | null;
  openEvidence: (meetingId: string, segmentIndex: number) => void;
  /** Recording detail slide-over (video, upload, transcript…). Mutually
   *  exclusive with the item panel — opening one closes the other. */
  selectedRecordingId: string | null;
  openRecording: (id: string) => void;
  close: () => void;
  /** Bumps each time an item is saved through the panel. List views subscribe
   *  to it to invalidate their caches. */
  refreshTick: number;
  bumpRefresh: () => void;
};

const ActivityPanelCtx = createContext<Ctx | null>(null);

export function ActivityPanelProvider({ children }: { children: React.ReactNode }) {
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(
    null,
  );
  const [evidenceTarget, setEvidenceTarget] = useState<Ctx["evidenceTarget"]>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const openItem = useCallback((id: string) => {
    setSelectedRecordingId(null);
    setEvidenceTarget(null);
    setSelectedItemId(id);
  }, []);
  const openEvidence = useCallback((meetingId: string, segmentIndex: number) => {
    setSelectedRecordingId(null);
    setSelectedItemId(meetingId);
    setEvidenceTarget({ segmentIndex, nonce: Date.now() });
  }, []);
  const openRecording = useCallback((id: string) => {
    setSelectedItemId(null);
    setEvidenceTarget(null);
    setSelectedRecordingId(id);
  }, []);
  const close = useCallback(() => {
    setSelectedItemId(null);
    setSelectedRecordingId(null);
    setEvidenceTarget(null);
  }, []);
  const bumpRefresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  const value = useMemo<Ctx>(
    () => ({
      selectedItemId,
      openItem,
      evidenceTarget,
      openEvidence,
      selectedRecordingId,
      openRecording,
      close,
      refreshTick,
      bumpRefresh,
    }),
    [
      selectedItemId,
      openItem,
      evidenceTarget,
      openEvidence,
      selectedRecordingId,
      openRecording,
      close,
      refreshTick,
      bumpRefresh,
    ],
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

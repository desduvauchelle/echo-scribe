import { useCallback, useEffect, useState } from "react";
import { guideRunsForTemplate, type GuideRun } from "../lib/api";
import { aggregateTrend, type TrendData } from "../lib/guideReview";

const CELL: Record<string, string> = {
  met: "bg-emerald-500/70",
  partial: "bg-amber-500/70",
  missed: "bg-red-500/70",
  unknown: "bg-elevated",
};

export default function GuideTrendView({
  templateId,
  templateName,
  onClose,
}: {
  templateId: string;
  templateName: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<TrendData | null>(null);

  const load = useCallback(async () => {
    const runs: GuideRun[] = await guideRunsForTemplate(templateId, 12).catch(() => []);
    setData(aggregateTrend(runs));
  }, [templateId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded-xl border border-line bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-fg">{templateName} — across your calls</h2>
          <button className="text-muted hover:text-fg" onClick={onClose}>✕</button>
        </div>

        {!data || data.columns.length === 0 ? (
          <p className="text-[13px] text-muted">No completed guide reviews for this template yet.</p>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {data.gap ? (
                <div className="rounded-lg border border-line border-l-2 border-l-red-500 p-3">
                  <div className="text-[10px] font-bold uppercase text-faint">Recurring gap</div>
                  <div className="mt-1 text-[13px] font-medium text-fg">{data.gap}</div>
                </div>
              ) : null}
              {data.strength ? (
                <div className="rounded-lg border border-line border-l-2 border-l-emerald-500 p-3">
                  <div className="text-[10px] font-bold uppercase text-faint">Strength</div>
                  <div className="mt-1 text-[13px] font-medium text-fg">{data.strength}</div>
                </div>
              ) : null}
            </div>

            <div className="overflow-x-auto">
              <table className="border-separate border-spacing-1 text-[12px]">
                <thead>
                  <tr>
                    <th className="text-left font-normal text-faint"></th>
                    {data.columns.map((c) => (
                      <th key={c.runId} className="px-1 font-normal text-faint">
                        {c.startedAt.slice(5, 10)}
                      </th>
                    ))}
                    <th className="px-1 font-normal text-faint">hit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.criteria.map((crit, i) => (
                    <tr key={crit}>
                      <td className="whitespace-nowrap pr-2 font-medium text-fg">{crit}</td>
                      {data.columns.map((c) => (
                        <td key={c.runId} className="p-0">
                          <div className={`mx-auto h-5 w-5 rounded ${CELL[c.cells[i]] ?? CELL.unknown}`} />
                        </td>
                      ))}
                      <td className="px-1 text-center tabular-nums text-muted">
                        {data.hits[i]}/{data.columns.length}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

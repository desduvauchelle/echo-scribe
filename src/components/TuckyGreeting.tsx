import { useEffect, useState, type ReactNode } from "react";
import { RefreshCw, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";

const NEXT_KEY = "tucky.greeting.next";

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Optional presentation preference. */ }
}

/** Decorative illustration; the original app icon remains the brand mark. */
export function TuckyPeeking() {
  return <div className="tucky-peeking" aria-hidden="true">
    <img className="tucky-peeking-light" src="/mascot/peeking-light.png" alt="" width={156} height={130} draggable={false} />
    <img className="tucky-peeking-dark" src="/mascot/peeking-dark.png" alt="" width={156} height={130} draggable={false} />
  </div>;
}

/** `pulse` is a one-line activity summary shown under the subtitle. */
export default function TuckyGreeting({ pulse, focusNote, onEditFocusNote }: { pulse?: ReactNode; focusNote?: string; onEditFocusNote?: () => void } = {}) {
  const { t } = useTranslation("main");
  const titles = t("greeting.titles", { returnObjects: true });
  const count = Array.isArray(titles) && titles.length > 0 ? titles.length : 1;
  const [index, setIndex] = useState(() => {
    const value = Number(read(NEXT_KEY));
    return Number.isInteger(value) && value >= 0 ? value % count : 0;
  });
  const [focusExpanded, setFocusExpanded] = useState(false);
  useEffect(() => { write(NEXT_KEY, String((index + 1) % count)); }, [index, count]);
  return <section className="tucky-greeting" aria-label={t("greeting.label")}>
    <div className="tucky-greeting-copy">
      <h2>{t(`greeting.titles.${index}`)}</h2>
      <p className="tucky-greeting-sub">
        <span>{t(`greeting.descriptions.${index}`)}</span>
        <button type="button" className="tucky-greeting-another" aria-label={t("greeting.another")} title={t("greeting.another")}
          onClick={() => setIndex((value) => (value + 1) % count)}><RefreshCw size={11} aria-hidden="true" /></button>
      </p>
      {pulse}
      {focusNote ? <div className={`tucky-focus-bubble ${focusExpanded ? "is-expanded" : ""}`}>
        <span className="tucky-focus-bubble-label">{t("dashboard.morningFocus.today")}</span>
        <p>{focusNote}</p>
        <div className="tucky-focus-bubble-actions">
          <button type="button" onClick={() => setFocusExpanded((value) => !value)} aria-expanded={focusExpanded}>{focusExpanded ? t("dashboard.morningFocus.less") : t("dashboard.morningFocus.more")}</button>
          <button type="button" onClick={onEditFocusNote} aria-label={t("dashboard.morningFocus.edit")} title={t("dashboard.morningFocus.edit")}><Pencil size={13} aria-hidden="true" /></button>
        </div>
      </div> : null}
    </div>
    <TuckyPeeking />
  </section>;
}

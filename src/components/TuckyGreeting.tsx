import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";

const HIDDEN_KEY = "tucky.greeting.hidden";
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

export default function TuckyGreeting() {
  const { t } = useTranslation("main");
  const [hidden, setHidden] = useState(() => read(HIDDEN_KEY) === "true");
  const [index, setIndex] = useState(() => {
    const value = Number(read(NEXT_KEY));
    return Number.isInteger(value) && value >= 0 ? value % 3 : 0;
  });
  useEffect(() => { write(NEXT_KEY, String((index + 1) % 3)); }, [index]);
  const toggle = (value: boolean) => { setHidden(value); write(HIDDEN_KEY, String(value)); };
  if (hidden) return <div className="tucky-greeting-restore"><button type="button" onClick={() => toggle(false)}>{t("greeting.show")}</button></div>;
  return <section className="tucky-greeting" aria-label={t("greeting.label")}>
    <div className="tucky-greeting-copy">
      <h2>{t(`greeting.titles.${index}`)}</h2>
      <p>{t(`greeting.descriptions.${index}`)}</p>
      <div className="tucky-greeting-actions">
        <button type="button" onClick={() => setIndex((value) => (value + 1) % 3)}>{t("greeting.another")}<ArrowRight size={12} aria-hidden="true" /></button>
        <button type="button" onClick={() => toggle(true)}>{t("greeting.hide")}</button>
      </div>
    </div>
    <TuckyPeeking />
  </section>;
}

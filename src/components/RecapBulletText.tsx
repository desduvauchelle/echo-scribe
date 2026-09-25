import { splitRecapTopic } from "../lib/recapText";

/** Recap bullet with its "Topic:" lead-in bolded for scanability. */
export function RecapBulletText({ text }: { text: string }) {
  const { topic, body } = splitRecapTopic(text);
  if (!topic) return <span>{text}</span>;
  return (
    <span>
      <span className="font-semibold">{topic}:</span> {body}
    </span>
  );
}

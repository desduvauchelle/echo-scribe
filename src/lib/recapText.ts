/**
 * Recap bullets are written as "Topic: what happened". Split off the topic so
 * the UI can bold it; bullets without a short leading topic render as-is.
 */
export function splitRecapTopic(text: string): { topic: string | null; body: string } {
  const idx = text.indexOf(": ");
  if (idx <= 0 || idx > 40) return { topic: null, body: text };
  const topic = text.slice(0, idx).trim();
  const body = text.slice(idx + 2).trim();
  if (!body || topic.split(/\s+/).length > 4) return { topic: null, body: text };
  return { topic, body };
}

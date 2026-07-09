import type { FormatTemplate } from "./api";

export function updateTemplateName(
  template: FormatTemplate,
  name: string,
): FormatTemplate {
  return { ...template, name };
}

export function parseTriggerPhraseInput(input: string): string[] {
  return input
    .split(",")
    .map((phrase) => phrase.replace(/^\s+/, ""))
    .filter((phrase) => phrase.trim().length > 0);
}

export function formatTriggerPhraseInput(phrases: string[]): string {
  return phrases.join(", ");
}

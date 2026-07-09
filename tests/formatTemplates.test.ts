import { describe, expect, test } from "bun:test";
import {
  formatTriggerPhraseInput,
  parseTriggerPhraseInput,
  updateTemplateName,
} from "../src/lib/formatTemplates";
import type { FormatTemplate } from "../src/lib/api";

const baseTemplate: FormatTemplate = {
  id: "email",
  name: "Email",
  trigger_phrases: ["format as email", "make this an email"],
  system_prompt: "Rewrite as an email.",
};

describe("format template editing", () => {
  test("keeps template ids stable while editing the display name", () => {
    const renamed = updateTemplateName(baseTemplate, "Email draft");

    expect(renamed).toEqual({
      ...baseTemplate,
      id: "email",
      name: "Email draft",
    });
  });

  test("preserves spaces while editing trigger phrase text", () => {
    const input = "format as email, make this ";

    expect(parseTriggerPhraseInput(input)).toEqual([
      "format as email",
      "make this ",
    ]);
    expect(formatTriggerPhraseInput(parseTriggerPhraseInput(input))).toBe(input);
  });

  test("filters empty trigger phrases without trimming meaningful phrase text", () => {
    expect(parseTriggerPhraseInput("format as email, , make this an email")).toEqual([
      "format as email",
      "make this an email",
    ]);
  });
});

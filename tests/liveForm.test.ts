import { describe, expect, test } from "bun:test";
import { starterForm, parseFormConfig, formProgress, type FormAnswer } from "../src/lib/liveForm";

describe("live form", () => {
  test("starter template round trips without losing stable field ids", () => {
    const config = starterForm();
    expect(parseFormConfig(JSON.stringify(config))).toEqual(config);
    expect(parseFormConfig("freeform checklist notes")).toBeNull();
    expect(parseFormConfig(JSON.stringify({ ...config, fields: [config.fields[0], config.fields[0]] }))).toBeNull();
  });
  test("review and manually cleared answers do not complete required fields", () => {
    const config = starterForm();
    const answer = (id: string, value: string, status: FormAnswer["status"]): FormAnswer => ({ id, value, status, quote: "", speaker: "", start_ms: 0, end_ms: 0 });
    const answers = config.fields.map(f => answer(f.id, "known", "captured"));
    expect(formProgress(config, answers).requiredComplete).toBe(true);
    answers[1] = answer("email", "possible@example.com", "review");
    expect(formProgress(config, answers)).toMatchObject({ filled: 4, review: 1, requiredComplete: false });
    answers[1] = answer("email", "", "manual");
    expect(formProgress(config, answers)).toMatchObject({ filled: 4, review: 0, requiredComplete: false });
    answers[1] = answer("email", "correct@example.com", "manual");
    expect(formProgress(config, answers).requiredComplete).toBe(true);
  });
});

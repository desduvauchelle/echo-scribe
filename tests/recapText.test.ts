import { describe, expect, test } from "bun:test";
import { splitRecapTopic } from "../src/lib/recapText";

describe("splitRecapTopic", () => {
  test("splits a short leading topic", () => {
    expect(splitRecapTopic("CDI index: auto-syncs on case selection.")).toEqual({
      topic: "CDI index",
      body: "auto-syncs on case selection.",
    });
  });

  test("leaves sentences without a topic untouched", () => {
    const text = "The monetization model was confirmed: content creation is free.";
    expect(splitRecapTopic(text)).toEqual({ topic: null, body: text });
  });

  test("ignores a colon with nothing after it", () => {
    expect(splitRecapTopic("Note: ")).toEqual({ topic: null, body: "Note: " });
  });
});

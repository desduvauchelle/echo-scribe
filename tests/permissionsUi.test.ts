import { describe, expect, test } from "bun:test";
import { isPermissionRecheckBusy } from "../src/lib/permissionsUi";

describe("permissions UI refresh state", () => {
  test("does not show re-check buttons as busy during background polling", () => {
    expect(isPermissionRecheckBusy("auto")).toBe(false);
  });

  test("shows re-check buttons as busy during manual refreshes", () => {
    expect(isPermissionRecheckBusy("manual")).toBe(true);
  });
});

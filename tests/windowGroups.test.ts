import { expect, test } from "bun:test";
import { groupWindows } from "../src/screenrec-setup/windowGroups";

const sources = ["Notes", "Google Chrome", "Notes", "Terminal", "Google Chrome", "Terminal", "Terminal", "Google Chrome"].map((app, id) => ({
  id, app, title: `Document ${id}`, width: 800, height: 600, thumb: "",
}));

test("small apps stay inline, three-window apps group, and browsers default open", () => {
  const groups = groupWindows(sources, "");
  expect(groups.map(({ app, grouped, defaultExpanded }) => ({ app, grouped, defaultExpanded }))).toEqual([
    { app: "Notes", grouped: false, defaultExpanded: false },
    { app: "Google Chrome", grouped: true, defaultExpanded: true },
    { app: "Terminal", grouped: true, defaultExpanded: false },
  ]);
  expect(groups.flatMap((g) => g.windows).map((w) => w.id).sort()).toEqual(sources.map((w) => w.id));
});

test("search matches app names and titles without changing grouping thresholds", () => {
  expect(groupWindows(sources, "  CHROME ")[0].windows).toHaveLength(3);
  const groups = groupWindows(sources, "document 5");
  expect(groups).toHaveLength(1);
  expect(groups[0].grouped).toBe(true);
  expect(groups[0].total).toBe(3);
  expect(groups[0].windows[0].id).toBe(5);
  expect(groupWindows(sources, "not found")).toEqual([]);
  expect(groupWindows([], "")).toEqual([]);
});

test("browser variants open without matching unrelated app names", () => {
  for (const app of ["Safari", "Arc", "Dia", "Firefox Developer Edition", "Google Chrome Canary", "Microsoft Edge", "Brave Browser"]) {
    expect(groupWindows(sources.slice(0, 3).map((w) => ({ ...w, app })), "")[0].defaultExpanded).toBe(true);
  }
  expect(groupWindows(sources.map((w) => ({ ...w, app: "Chrome Tools" })), "")[0].defaultExpanded).toBe(false);
});

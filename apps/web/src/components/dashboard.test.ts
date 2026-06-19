import { describe, expect, it } from "vitest";
import { demoCases } from "@/lib/case-data";
import { filterCases, summarizeCases } from "./dashboard";

describe("dashboard case filtering", () => {
  it("summarizes operational queues", () => {
    expect(summarizeCases(demoCases)).toMatchObject({
      open: 2,
      attention: 1,
      promises: 1,
      installments: 0,
      closed: 0,
      communications: 1
    });
  });

  it("filters attention cases and searches debtor identity", () => {
    expect(filterCases(demoCases, "ATTENTION", "")).toHaveLength(1);
    expect(filterCases(demoCases, "ALL", "Július")).toEqual([
      expect.objectContaining({ id: "demo-1" })
    ]);
    expect(filterCases(demoCases, "ALL", "missing")).toEqual([]);
  });

  it("backs sidebar views with real case filters", () => {
    expect(filterCases(demoCases, "COMMUNICATIONS", "")).toEqual([
      expect.objectContaining({ id: "demo-1" })
    ]);
    expect(filterCases(demoCases, "WORKFLOW", "")).toEqual([
      expect.objectContaining({ id: "demo-1" })
    ]);
    expect(filterCases(demoCases, "LEGAL", "")).toEqual([]);
    expect(filterCases(demoCases, "CLOSED", "")).toEqual([]);
  });
});

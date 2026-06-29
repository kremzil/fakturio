import { describe, expect, it } from "vitest";
import { demoCases } from "@/lib/case-data";
import type { DashboardDebtor } from "@/lib/debtor-data";
import {
  filterCases,
  filterDebtors,
  summarizeCases,
  summarizeDebtors
} from "./dashboard";

const debtors: DashboardDebtor[] = [
  {
    id: "debtor-1",
    name: "Alfa s.r.o.",
    email: "uctaren@alfa.example",
    ico: "12345678",
    dic: null,
    icDph: null,
    address: "Bratislava",
    caseCount: 3,
    openCaseCount: 2,
    closedCaseCount: 1,
    openAmounts: [{ currency: "EUR", amount: 200 }],
    lastCaseAt: "2026-06-20T00:00:00.000Z"
  },
  {
    id: "debtor-2",
    name: "Beta s.r.o.",
    email: null,
    ico: null,
    dic: null,
    icDph: null,
    address: null,
    caseCount: 1,
    openCaseCount: 0,
    closedCaseCount: 1,
    openAmounts: [],
    lastCaseAt: "2026-05-20T00:00:00.000Z"
  }
];

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

describe("dashboard debtor grouping", () => {
  it("summarizes grouped debtor records", () => {
    expect(summarizeDebtors(debtors)).toEqual({
      total: 2,
      active: 1,
      withoutEmail: 1,
      cases: 4
    });
  });

  it("filters active debtors and searches identity fields", () => {
    expect(filterDebtors(debtors, "ACTIVE", "")).toEqual([debtors[0]]);
    expect(filterDebtors(debtors, "WITHOUT_EMAIL", "")).toEqual([debtors[1]]);
    expect(filterDebtors(debtors, "ALL", "12345678")).toEqual([debtors[0]]);
    expect(filterDebtors(debtors, "ALL", "missing")).toEqual([]);
  });
});

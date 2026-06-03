import { describe, expect, it } from "vitest";
import { buildCaseObjectKey } from "./types";

describe("storage", () => {
  it("builds deterministic case-scoped object key prefixes", () => {
    const key = buildCaseObjectKey({
      organizationId: "org_1",
      caseId: "case_1",
      fileName: "faktúra 01.pdf"
    });

    expect(key).toContain("organizations/org_1/cases/case_1/invoice/");
    expect(key.endsWith("-fakt-ra-01.pdf")).toBe(true);
  });
});

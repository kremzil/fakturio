import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@fakturio/db";
import { getCaseForOrg, listCasesForOrg, updateCaseForOrg } from "./case-access";

/**
 * Cross-tenant isolation tests against the live local Postgres.
 *
 * These verify the organization boundary enforced by the case-access helpers:
 * org A must never be able to read or mutate org B's cases, and listings must
 * be scoped to a single organization. Run via `npm run test:integration` with
 * the docker compose stack up.
 */

const RUN_ID = `it-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const orgAId = `${RUN_ID}-org-a`;
const orgBId = `${RUN_ID}-org-b`;
const caseAId = `${RUN_ID}-case-a`;
const caseBId = `${RUN_ID}-case-b`;

async function createOrgWithCase(orgId: string, caseId: string, invoiceNumber: string) {
  await prisma.organization.create({
    data: {
      id: orgId,
      name: `Org ${orgId}`,
      slug: orgId
    }
  });

  await prisma.case.create({
    data: {
      id: caseId,
      organizationId: orgId,
      status: "WAITING_FOR_DUE_DATE",
      invoiceNumber
    }
  });
}

beforeAll(async () => {
  await createOrgWithCase(orgAId, caseAId, "INV-A-001");
  await createOrgWithCase(orgBId, caseBId, "INV-B-001");
});

afterAll(async () => {
  // Cases cascade-delete with their organization.
  await prisma.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
  await prisma.$disconnect();
});

describe("case-access tenant isolation (integration)", () => {
  it("getCaseForOrg returns the case for its owning organization", async () => {
    const found = await getCaseForOrg(caseAId, orgAId);
    expect(found?.id).toBe(caseAId);
    expect(found?.organizationId).toBe(orgAId);
  });

  it("getCaseForOrg returns null when another organization requests the case", async () => {
    const leaked = await getCaseForOrg(caseAId, orgBId);
    expect(leaked).toBeNull();
  });

  it("listCasesForOrg only returns cases owned by the organization", async () => {
    const orgACases = await listCasesForOrg(orgAId);
    const orgBCases = await listCasesForOrg(orgBId);

    expect(orgACases.map((c) => c.id)).toEqual([caseAId]);
    expect(orgBCases.map((c) => c.id)).toEqual([caseBId]);
  });

  it("updateCaseForOrg applies the change for the owning organization", async () => {
    const updated = await updateCaseForOrg(caseAId, orgAId, { status: "CLOSED_PAID" });
    expect(updated?.status).toBe("CLOSED_PAID");

    const reloaded = await getCaseForOrg(caseAId, orgAId);
    expect(reloaded?.status).toBe("CLOSED_PAID");
  });

  it("updateCaseForOrg returns null and does not mutate when another org attempts the update", async () => {
    const before = await getCaseForOrg(caseBId, orgBId);
    expect(before?.status).toBe("WAITING_FOR_DUE_DATE");

    const result = await updateCaseForOrg(caseBId, orgAId, { status: "CLOSED_PAID" });
    expect(result).toBeNull();

    // The row must be untouched by the cross-tenant attempt.
    const after = await getCaseForOrg(caseBId, orgBId);
    expect(after?.status).toBe("WAITING_FOR_DUE_DATE");
  });
});

import type { Prisma } from "@prisma/client";
import { prisma } from "@fakturio/db";
import { CASE_STATE_CHANGED_COMMAND } from "@fakturio/workflows";
import type { CaseStatus } from "@fakturio/shared";

/**
 * Organization-scoped data access for cases.
 *
 * Every read and mutation that targets a specific case must go through these helpers so the
 * organization boundary is enforced in one place. `case.id` is globally unique, so a plain
 * `update({ where: { id } })` cannot encode the org constraint; mutations therefore verify
 * ownership and apply the change atomically inside a transaction.
 */

export function getCaseForOrg<Include extends Prisma.CaseInclude | undefined = undefined>(
  caseId: string,
  organizationId: string,
  include?: Include
): Promise<Prisma.CaseGetPayload<{ include: Include }> | null> {
  return prisma.case.findFirst({
    where: { id: caseId, organizationId },
    include
  }) as Promise<Prisma.CaseGetPayload<{ include: Include }> | null>;
}

export function listCasesForOrg<Include extends Prisma.CaseInclude | undefined = undefined>(
  organizationId: string,
  args?: { include?: Include; take?: number; orderBy?: Prisma.CaseOrderByWithRelationInput }
): Promise<Prisma.CaseGetPayload<{ include: Include }>[]> {
  return prisma.case.findMany({
    where: { organizationId },
    include: args?.include,
    take: args?.take,
    orderBy: args?.orderBy
  }) as Promise<Prisma.CaseGetPayload<{ include: Include }>[]>;
}

/**
 * Atomically verifies the case belongs to the organization and applies the update.
 * Returns null when the case does not exist within the organization (caller maps to 404).
 */
export async function updateCaseForOrg<Include extends Prisma.CaseInclude | undefined = undefined>(
  caseId: string,
  organizationId: string,
  data: CaseUpdateData,
  include?: Include
): Promise<Prisma.CaseGetPayload<{ include: Include }> | null> {
  assertNoOrganizationReassignment(data);

  return prisma.$transaction(async (tx) => {
    const owned = await tx.case.findFirst({
      where: { id: caseId, organizationId },
      select: { id: true }
    });

    if (!owned) {
      return null;
    }

    await assertConnectedEntitiesInOrg(tx, organizationId, data);

    const updated = await tx.case.update({
      where: { id: caseId },
      // The public `CaseUpdateData` type is the real tenant boundary; it is structurally a
      // subset of Prisma's input, so the cast only re-widens to the driver's expected type.
      data: data as Prisma.CaseUpdateInput,
      include
    });

    return updated as Prisma.CaseGetPayload<{ include: Include }>;
  });
}

export async function updateCaseForOrgAndEnqueueStateChange<
  Include extends Prisma.CaseInclude | undefined = undefined
>(
  caseId: string,
  organizationId: string,
  data: CaseUpdateData,
  command: { status: CaseStatus; idempotencyKey: string; source: string },
  include?: Include
): Promise<Prisma.CaseGetPayload<{ include: Include }> | null> {
  assertNoOrganizationReassignment(data);

  return prisma.$transaction(async (tx) => {
    const owned = await tx.case.findFirst({
      where: { id: caseId, organizationId },
      select: { id: true }
    });

    if (!owned) {
      return null;
    }

    await assertConnectedEntitiesInOrg(tx, organizationId, data);
    const updated = await tx.case.update({
      where: { id: caseId },
      data: data as Prisma.CaseUpdateInput,
      include
    });

    await tx.workflowCommand.upsert({
      where: { idempotencyKey: command.idempotencyKey },
      create: {
        caseId,
        organizationId,
        type: CASE_STATE_CHANGED_COMMAND,
        idempotencyKey: command.idempotencyKey,
        payload: {
          status: command.status,
          source: command.source
        }
      },
      update: {}
    });

    return updated as Prisma.CaseGetPayload<{ include: Include }>;
  });
}

/**
 * Narrow, allowlisted shape accepted by `updateCaseForOrg`.
 *
 * Accepting the full `Prisma.CaseUpdateInput` is unsafe: it permits `connectOrCreate`, `upsert`,
 * nested relation `update`, and reconnection of `invoiceDocuments`/`communications`/`events`/
 * `paymentPromises` — any of which could reach across the tenant boundary or mutate another
 * org's rows. We therefore expose only the scalar/JSON columns callers actually set, plus a
 * single tightly constrained `debtor.connect` (validated against the org at runtime) and an
 * append-only `events.create`. The `organization` relation is deliberately excluded.
 */
export type CaseUpdateData = Pick<
  Prisma.CaseUpdateInput,
  | "status"
  | "invoiceNumber"
  | "issueDate"
  | "dueDate"
  | "amountTotal"
  | "currency"
  | "supplierSnapshot"
  | "debtorSnapshot"
  | "paymentSnapshot"
  | "subjectNote"
  | "warnings"
  | "confirmedByUserId"
  | "confirmedAt"
  | "closedAt"
  | "nextActionAt"
  | "automationPausedAt"
  | "automationPauseReason"
> & {
  debtor?: { connect: { id: string } };
  events?: { create: CaseEventCreateData };
};

type CaseEventCreateData = {
  actorType: Prisma.CaseEventCreateWithoutCaseInput["actorType"];
  actorId?: string | null;
  type: string;
  note?: string | null;
  payload?: Prisma.InputJsonValue;
};

/**
 * The org boundary is only meaningful if a case cannot be moved out of its organization through
 * this helper. Reject any update that touches the organization relation/foreign key so a caller
 * cannot reassign a case (or, via nested writes on that relation, reach another org's data).
 */
function assertNoOrganizationReassignment(data: CaseUpdateData): void {
  if ("organization" in data || "organizationId" in data) {
    throw new Error("updateCaseForOrg must not change the case organization.");
  }
}

/**
 * Reject connecting a debtor that belongs to a different organization. Schema-level foreign keys
 * do not encode the org match, so an attacker-controlled `connect: { id }` could otherwise attach
 * another tenant's debtor to this case.
 */
async function assertConnectedEntitiesInOrg(
  tx: Prisma.TransactionClient,
  organizationId: string,
  data: CaseUpdateData
): Promise<void> {
  const debtorId = extractConnectId(data.debtor);
  if (debtorId) {
    const debtor = await tx.debtor.findFirst({
      where: { id: debtorId, organizationId },
      select: { id: true }
    });
    if (!debtor) {
      throw new Error("Cannot connect a debtor from another organization.");
    }
  }
}

function extractConnectId(relation: unknown): string | null {
  if (!relation || typeof relation !== "object") {
    return null;
  }
  const connect = (relation as { connect?: { id?: unknown } }).connect;
  return connect && typeof connect.id === "string" ? connect.id : null;
}

import { prisma } from "@fakturio/db";
import {
  CASE_EVENT_TYPES,
  TERMINAL_CASE_STATUSES,
  type CaseStatus
} from "@fakturio/shared";
import { dashboardCaseInclude, toDashboardCase } from "./case-data";
import { CaseActionConflictError } from "./case-actions";

export async function updateDebtorEmailForOrg(input: {
  caseId: string;
  organizationId: string;
  userId: string;
  email: string;
}) {
  return prisma.$transaction(async (tx) => {
    const collectionCase = await tx.case.findFirst({
      where: { id: input.caseId, organizationId: input.organizationId },
      include: { debtor: true }
    });

    if (!collectionCase) {
      return null;
    }
    if (
      !collectionCase.confirmedAt ||
      TERMINAL_CASE_STATUSES.includes(collectionCase.status as CaseStatus)
    ) {
      throw new CaseActionConflictError(
        "Kontakt možno meniť iba pri aktívnom potvrdenom prípade."
      );
    }

    const debtorSnapshot = toRecord(collectionCase.debtorSnapshot);
    let debtorId = collectionCase.debtorId;
    if (debtorId) {
      const updated = await tx.debtor.updateMany({
        where: { id: debtorId, organizationId: input.organizationId },
        data: { email: input.email }
      });
      if (updated.count !== 1) {
        throw new Error("Case debtor does not belong to the organization.");
      }
    } else {
      const name = stringValue(debtorSnapshot.name);
      if (!name) {
        throw new CaseActionConflictError(
          "Najprv doplňte názov dlžníka v manuálnej kontrole."
        );
      }
      const debtor = await tx.debtor.create({
        data: {
          organizationId: input.organizationId,
          name,
          email: input.email
        }
      });
      debtorId = debtor.id;
    }

    const updatedCase = await tx.case.update({
      where: { id: collectionCase.id },
      data: {
        debtorId,
        debtorSnapshot: { ...debtorSnapshot, email: input.email },
        events: {
          create: {
            actorType: "USER",
            actorId: input.userId,
            type: CASE_EVENT_TYPES.contactUpdated,
            note: "Email dlžníka bol manuálne aktualizovaný."
          }
        }
      },
      include: dashboardCaseInclude
    });

    return toDashboardCase(updatedCase);
  });
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

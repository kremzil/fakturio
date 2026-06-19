import { prisma } from "@fakturio/db";
import {
  CASE_EVENT_TYPES,
  TERMINAL_CASE_STATUSES,
  WORKFLOW_COMMAND_TYPES,
  assertCaseTransition,
  type CaseStatus
} from "@fakturio/shared";
import { dashboardCaseInclude, toDashboardCase } from "./case-data";

export const MANUAL_CASE_ACTIONS = [
  "MARK_PAID",
  "PAUSE_AUTOMATION",
  "RESUME_AUTOMATION",
  "CANCEL_CASE"
] as const;

export type ManualCaseAction = (typeof MANUAL_CASE_ACTIONS)[number];

export class CaseActionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseActionConflictError";
  }
}

export async function applyManualCaseAction(input: {
  caseId: string;
  organizationId: string;
  userId: string;
  action: ManualCaseAction;
}) {
  return prisma.$transaction(async (tx) => {
    const collectionCase = await tx.case.findFirst({
      where: {
        id: input.caseId,
        organizationId: input.organizationId
      },
      include: {
        paymentPromises: {
          where: { fulfilledAt: null, brokenAt: null },
          orderBy: { promisedDate: "desc" },
          take: 1
        },
        installmentPlans: {
          where: { status: "ACTIVE" },
          take: 1,
          include: {
            payments: {
              where: { status: "PENDING" },
              orderBy: { sequence: "asc" },
              take: 1
            }
          }
        }
      }
    });

    if (!collectionCase) {
      return null;
    }

    const status = collectionCase.status as CaseStatus;
    const terminal = TERMINAL_CASE_STATUSES.includes(status);
    if (input.action !== "CANCEL_CASE" && terminal) {
      throw new CaseActionConflictError(
        "Uzavretý prípad už nemožno meniť."
      );
    }

    const now = new Date();
    let update: {
      status?: CaseStatus;
      closedAt?: Date | null;
      nextActionAt?: Date | null;
      automationPausedAt?: Date | null;
      automationPauseReason?: string | null;
    };
    let note: string;
    let commandKey: string;
    let shouldEnqueueCommand = true;

    if (
      (input.action === "PAUSE_AUTOMATION" ||
        input.action === "RESUME_AUTOMATION" ||
        input.action === "MARK_PAID") &&
      !collectionCase.confirmedAt
    ) {
      throw new CaseActionConflictError(
        "Najprv potvrďte faktúru a spustite workflow."
      );
    }

    if (input.action === "MARK_PAID") {
      if (terminal) {
        throw new CaseActionConflictError(
          "Uzavretý prípad už nemožno označiť ako uhradený."
        );
      }
      assertCaseTransition(status, "CLOSED_PAID");
      update = {
        status: "CLOSED_PAID",
        closedAt: now,
        nextActionAt: null,
        automationPausedAt: null,
        automationPauseReason: null
      };
      note = "Prípad bol manuálne označený ako uhradený.";
      commandKey = `manual-paid:${input.caseId}:${collectionCase.updatedAt.toISOString()}`;
    } else if (input.action === "PAUSE_AUTOMATION") {
      if (collectionCase.automationPausedAt) {
        return toDashboardCase(
          await tx.case.findFirstOrThrow({
            where: {
              id: input.caseId,
              organizationId: input.organizationId
            },
            include: dashboardCaseInclude
          })
        );
      }
      update = {
        automationPausedAt: now,
        automationPauseReason: "MANUAL_PAUSE"
      };
      note = "Automatizácia bola manuálne pozastavená.";
      commandKey = `manual-pause:${input.caseId}:${collectionCase.updatedAt.toISOString()}`;
    } else if (input.action === "RESUME_AUTOMATION") {
      if (!collectionCase.automationPausedAt) {
        return toDashboardCase(
          await tx.case.findFirstOrThrow({
            where: {
              id: input.caseId,
              organizationId: input.organizationId
            },
            include: dashboardCaseInclude
          })
        );
      }
      update = {
        nextActionAt: resolveResumeActionAt(collectionCase),
        automationPausedAt: null,
        automationPauseReason: null
      };
      note = "Automatizácia bola manuálne obnovená.";
      commandKey = `manual-resume:${input.caseId}:${collectionCase.automationPausedAt.toISOString()}`;
    } else {
      if (status === "CLOSED_CANCELLED") {
        return toDashboardCase(
          await tx.case.findFirstOrThrow({
            where: {
              id: input.caseId,
              organizationId: input.organizationId
            },
            include: dashboardCaseInclude
          })
        );
      }
      if (terminal) {
        throw new CaseActionConflictError(
          "Uzavretý prípad už nemožno zastaviť."
        );
      }
      assertCaseTransition(status, "CLOSED_CANCELLED");
      update = {
        status: "CLOSED_CANCELLED",
        closedAt: now,
        nextActionAt: null,
        automationPausedAt: null,
        automationPauseReason: null
      };
      note = "Prípad a jeho automatizácia boli manuálne zastavené.";
      commandKey = `manual-cancel:${input.caseId}:${collectionCase.updatedAt.toISOString()}`;
      shouldEnqueueCommand = Boolean(
        collectionCase.confirmedAt || collectionCase.workflowId
      );
    }

    const result = await tx.case.updateMany({
      where: {
        id: input.caseId,
        organizationId: input.organizationId,
        updatedAt: collectionCase.updatedAt
      },
      data: update
    });
    if (result.count !== 1) {
      throw new CaseActionConflictError(
        "Prípad sa medzitým zmenil. Obnovte údaje a skúste akciu znova."
      );
    }

    await tx.caseEvent.create({
      data: {
        caseId: input.caseId,
        actorType: "USER",
        actorId: input.userId,
        type:
          input.action === "PAUSE_AUTOMATION"
            ? CASE_EVENT_TYPES.automationPaused
            : input.action === "MARK_PAID"
              ? CASE_EVENT_TYPES.paymentMarkedPaid
              : CASE_EVENT_TYPES.statusChanged,
        note,
        payload: { action: input.action }
      }
    });

    if (shouldEnqueueCommand) {
      await tx.workflowCommand.upsert({
        where: { idempotencyKey: commandKey },
        create: {
          caseId: input.caseId,
          organizationId: input.organizationId,
          type: WORKFLOW_COMMAND_TYPES.caseStateChanged,
          idempotencyKey: commandKey,
          payload: {
            status: update.status ?? status,
            source: "DASHBOARD",
            action: input.action
          }
        },
        update: {}
      });
    }

    return toDashboardCase(
      await tx.case.findFirstOrThrow({
        where: {
          id: input.caseId,
          organizationId: input.organizationId
        },
        include: dashboardCaseInclude
      })
    );
  });
}

function resolveResumeActionAt(collectionCase: {
  status: string;
  dueDate: Date | null;
  nextActionAt: Date | null;
  paymentPromises: Array<{ promisedDate: Date }>;
  installmentPlans: Array<{ payments: Array<{ dueDate: Date }> }>;
}): Date | null {
  if (collectionCase.nextActionAt) {
    return collectionCase.nextActionAt;
  }
  if (collectionCase.status === "WAITING_FOR_DUE_DATE") {
    return collectionCase.dueDate;
  }
  if (collectionCase.status === "PAYMENT_PROMISED") {
    return collectionCase.paymentPromises[0]?.promisedDate ?? new Date();
  }
  if (collectionCase.status === "INSTALLMENT_ACTIVE") {
    return collectionCase.installmentPlans[0]?.payments[0]?.dueDate ?? null;
  }
  if (collectionCase.status === "EMAIL_REMINDER_1_SENT") {
    return new Date();
  }
  return null;
}

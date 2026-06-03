import { CASE_EVENT_TYPES } from "@fakturio/shared";
import { prisma } from "@fakturio/db";
import type { CaseSnapshot, CaseWorkflowActivities } from "@fakturio/workflows";

export const activities: CaseWorkflowActivities = {
  async loadCaseSnapshot(input): Promise<CaseSnapshot> {
    const collectionCase = await prisma.case.findUniqueOrThrow({
      where: { id: input.caseId },
      include: { debtor: true }
    });

    return {
      id: collectionCase.id,
      status: collectionCase.status,
      dueDate: collectionCase.dueDate?.toISOString().slice(0, 10) ?? null,
      invoiceNumber: collectionCase.invoiceNumber,
      amountTotal: collectionCase.amountTotal ? Number(collectionCase.amountTotal) : null,
      currency: collectionCase.currency,
      debtorName: collectionCase.debtor?.name ?? null,
      debtorEmail: collectionCase.debtor?.email ?? null
    };
  },

  async recordWorkflowEvent(input) {
    await prisma.caseEvent.create({
      data: {
        caseId: input.caseId,
        actorType: "WORKFLOW",
        type: input.type,
        note: input.note
      }
    });
  },

  async sendReminderEmail(input) {
    await prisma.caseEvent.create({
      data: {
        caseId: input.caseId,
        actorType: "WORKFLOW",
        type: CASE_EVENT_TYPES.emailSent,
        note: `Reminder ${input.reminderLevel} scheduled for email provider.`
      }
    });
  },

  async markCaseOverdue(input) {
    await prisma.case.update({
      where: { id: input.caseId },
      data: { status: "OVERDUE" }
    });
  }
};

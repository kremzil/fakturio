import { z } from "zod";

export const dashboardCaseAssistantMessageSchema = z.object({
  direction: z.enum(["INBOUND", "OUTBOUND"]),
  fromAddress: z.string().nullable(),
  toAddress: z.string().nullable(),
  subject: z.string().nullable(),
  textBody: z.string().nullable(),
  createdAt: z.string(),
  kind: z.string().nullable(),
  aiSummary: z.string().nullable(),
  aiIntent: z.string().nullable()
});

export const dashboardCaseAssistantInputSchema = z.object({
  organizationId: z.string(),
  caseId: z.string(),
  userMessage: z.string(),
  userLanguage: z.enum(["sk", "ru"]),
  caseSnapshot: z.object({
    invoiceNumber: z.string().nullable(),
    status: z.string(),
    debtorName: z.string().nullable(),
    debtorEmail: z.string().nullable(),
    supplierName: z.string().nullable(),
    amountTotal: z.number().nullable(),
    currency: z.string().nullable(),
    dueDate: z.string().nullable(),
    automationPaused: z.boolean(),
    automationPauseReason: z.string().nullable(),
    nextActionAt: z.string().nullable()
  }),
  recentEvents: z.array(
    z.object({
      type: z.string(),
      actorType: z.string(),
      note: z.string().nullable(),
      createdAt: z.string(),
      payload: z.unknown().nullable()
    })
  ),
  recentCommunications: z.array(dashboardCaseAssistantMessageSchema),
  allowedActions: z.array(z.string())
});

export const dashboardCaseAssistantReplySchema = z.object({
  subject: z.string(),
  textBody: z.string(),
  suggestedActions: z.array(z.string()),
  needsHumanDecision: z.boolean()
});

export type DashboardCaseAssistantInput = z.infer<typeof dashboardCaseAssistantInputSchema>;
export type DashboardCaseAssistantReply = z.infer<typeof dashboardCaseAssistantReplySchema>;

import { Prisma } from "@prisma/client";
import { createAiProvider } from "@fakturio/ai";
import { prisma } from "@fakturio/db";
import {
  buildCustomerActionNeedsConfirmation,
  buildCustomerAmbiguousCaseFollowUp,
  buildCustomerAssistantAcknowledgement,
  buildCustomerCaseStatusReply,
  buildCustomerManualReviewEscalation,
  buildCustomerMissingFieldsFollowUp,
  buildCustomerAuthorizedDebtorMessage,
  buildInstallmentProposal,
  createEmailProvider,
  type EmailProvider,
  type InboundEmail
} from "@fakturio/email";
import {
  CASE_EVENT_TYPES,
  CASE_CONFIRM_TOKEN_DEFAULT_TTL_MS,
  CUSTOMER_COMMUNICATION_KINDS,
  assertCaseTransition,
  calculateInstallmentSchedule,
  type CaseStatus,
  type CustomerMessageClassification,
  type CustomerMessageInput,
  cleanText,
  createCaseConfirmToken,
  createCaseClarificationAddress,
  createCaseReplyAddress,
  emptyCustomerExtractedInvoiceFields,
  parseIsoDate,
  requireCaseConfirmTokenSecret,
  requireInboundReplyTokenSecret,
  validateInvoiceForWorkflow,
  verifyCaseClarificationAddress,
  type AiProvider
} from "@fakturio/shared";
import { createStorageProvider, type StorageProvider } from "@fakturio/storage";
import type { EmailOrganizationRoute } from "./email-routing";
import { InvoiceIntakeService } from "./service";

const CUSTOMER_MESSAGE_CONFIDENCE_THRESHOLD = 0.8;
const MUTATING_INTENTS = new Set([
  "REQUEST_PAUSE",
  "REQUEST_RESUME",
  "REQUEST_MARK_PAID",
  "REQUEST_CANCEL"
]);

export type CustomerEmailAssistantResult = {
  caseId: string | null;
  organizationId: string;
  communicationId: string | null;
  duplicate: boolean;
  appliedFields: string[];
  stillMissing: string[];
  status: string | null;
  intent: string;
  replySent: boolean;
};

type CustomerEmailAssistantDependencies = {
  ai: AiProvider;
  email: EmailProvider;
  storage: StorageProvider;
};

type CustomerAssistantActionResult =
  | { kind: "NONE" }
  | { kind: "CASE_CONFIRMED" }
  | { kind: "CASE_ALREADY_CONFIRMED" }
  | { kind: "INSTALLMENT_PROPOSAL_SENT" }
  | { kind: "INSTALLMENT_PROPOSAL_ALREADY_EXISTS" }
  | { kind: "DEBTOR_MESSAGE_SENT" }
  | { kind: "ACTION_BLOCKED"; reason: string };

type CustomerCandidateCase = NonNullable<CustomerMessageInput["candidateCases"]>[number];

type CorrelationResult =
  | {
      kind: "CASE";
      caseId: string;
      organizationId: string;
      correlation:
        | "SIGNED_CLARIFICATION_ADDRESS"
        | "CUSTOMER_MESSAGE_THREAD"
        | "CUSTOMER_ALIAS_REFERENCE";
      matchedAddress: string | null;
      classification?: CustomerMessageClassification;
    }
  | {
      kind: "AMBIGUOUS";
      organizationId: string;
      matchedAddress: string | null;
      reason: "NO_CASE_REFERENCE" | "MULTIPLE_CASES" | "NO_CASE_MATCH";
    };

export class CustomerEmailAssistantService {
  private readonly deps: CustomerEmailAssistantDependencies;

  constructor(deps: Partial<CustomerEmailAssistantDependencies> = {}) {
    this.deps = {
      ai: deps.ai ?? createAiProvider(),
      email: deps.email ?? createEmailProvider(),
      storage: deps.storage ?? createStorageProvider()
    };
  }

  async process(
    email: InboundEmail,
    route?: EmailOrganizationRoute
  ): Promise<CustomerEmailAssistantResult | null> {
    const matched = await resolveCustomerAssistantCase(email, route, this.deps.ai);
    if (!matched) {
      return null;
    }

    if (matched.kind === "AMBIGUOUS") {
      const unmatched = await sendUnmatchedFollowUp({
        deps: this.deps,
        email,
        organizationId: matched.organizationId,
        matchedAddress: matched.matchedAddress,
        reason: matched.reason
      });
      return {
        caseId: unmatched.caseId,
        organizationId: matched.organizationId,
        communicationId: unmatched.communicationId,
        duplicate: unmatched.duplicate,
        appliedFields: [],
        stillMissing: [],
        status: "MANUAL_REVIEW_REQUIRED",
        intent: "OTHER",
        replySent: unmatched.replySent
      };
    }

    const idempotencyKey = `customer-assistant:${email.provider}:${email.providerId}`;
    const existing = await prisma.communication.findUnique({
      where: { idempotencyKey },
      include: { case: true }
    });
    if (existing) {
      return {
        caseId: existing.caseId,
        organizationId: existing.case.organizationId,
        communicationId: existing.id,
        duplicate: true,
        appliedFields: [],
        stillMissing: [],
        status: existing.case.status,
        intent: stringValue(jsonRecord(existing.aiClassification).intent) ?? "OTHER",
        replySent: false
      };
    }

    const collectionCase = await prisma.case.findFirst({
      where: {
        id: matched.caseId,
        organizationId: matched.organizationId
      },
      include: {
        debtor: true,
        events: { orderBy: { createdAt: "desc" }, take: 8 }
      }
    });
    if (!collectionCase) {
      return null;
    }

    const multiAttachmentClarification = await new InvoiceIntakeService({
      ai: this.deps.ai,
      email: this.deps.email,
      storage: this.deps.storage
    }).resolveMultiAttachmentClarification({
      organizationId: collectionCase.organizationId,
      caseId: collectionCase.id,
      email
    });
    if (multiAttachmentClarification) {
      if (!multiAttachmentClarification.stillNeedsClarification) {
        const template = buildCustomerAssistantAcknowledgement({
          invoiceNumber: collectionCase.invoiceNumber,
          summary:
            multiAttachmentClarification.caseIds.length > 1
              ? "Dokumenty sme rozdelili a začali spracovanie jednotlivých faktúr."
              : "Dokumenty sme priradili k jednej faktúre a začali spracovanie.",
          stillMissing: [],
          dashboardUrl: dashboardUrl(collectionCase.id)
        });
        await sendAssistantReply({
          deps: this.deps,
          caseId: collectionCase.id,
          inboundCommunicationId: multiAttachmentClarification.communicationId,
          to: email.from,
          template,
          idempotencyKey: `customer-multi-attachment-resolved-reply:${email.provider}:${email.providerId}`
        });
      }

      return {
        caseId: collectionCase.id,
        organizationId: collectionCase.organizationId,
        communicationId: multiAttachmentClarification.communicationId,
        duplicate: false,
        appliedFields: [],
        stillMissing: [],
        status: multiAttachmentClarification.status,
        intent: "PROVIDE_INVOICE_FIELDS",
        replySent: true
      };
    }

    const classification = matched.classification
      ? normalizeCustomerClassification(matched.classification)
      : await classifyCustomerEmail({
          ai: this.deps.ai,
          email,
          organizationId: collectionCase.organizationId,
          latestCaseSummary: summarizeCaseForAi(collectionCase)
        });
    const safeClassification = mergeDeterministicFieldExtraction(
      stripQuotedEmailText(email.textBody ?? ""),
      classification
    );

    return prisma.$transaction(async (tx) => {
      const communication = await tx.communication.create({
        data: {
          caseId: collectionCase.id,
          direction: "INBOUND",
          channel: "EMAIL",
          status: "RECEIVED",
          idempotencyKey,
          provider: email.provider,
          providerId: email.providerId,
          messageId: normalizeMessageId(email.messageId),
          inReplyTo: normalizeMessageId(email.inReplyTo),
          references: email.references
            .map(normalizeMessageId)
            .filter((value): value is string => Boolean(value)),
          fromAddress: email.from,
          toAddress: email.to.join(", "),
          subject: email.subject,
          textBody: email.textBody,
          htmlBody: email.htmlBody,
          rawPayload: {
            kind: CUSTOMER_COMMUNICATION_KINDS.emailAssistantMessage,
            correlation: matched.correlation
          },
          aiClassification: toJsonValue(safeClassification),
          receivedAt: new Date()
        }
      });

      const decision = applySafeCustomerDecision(collectionCase, safeClassification);
      const caseUpdate: Prisma.CaseUpdateInput = { ...(decision.caseUpdate ?? {}) };
      if (decision.debtorPatch) {
        if (collectionCase.debtorId) {
          await tx.debtor.updateMany({
            where: {
              id: collectionCase.debtorId,
              organizationId: collectionCase.organizationId,
              email: null
            },
            data: {
              email: decision.debtorPatch.email ?? undefined
            }
          });
        } else if (decision.debtorPatch.name) {
          const debtor = await tx.debtor.create({
            data: {
              organizationId: collectionCase.organizationId,
              name: decision.debtorPatch.name,
              email: decision.debtorPatch.email
            }
          });
          caseUpdate.debtor = { connect: { id: debtor.id } };
        }
      }

      let updatedStatus = collectionCase.status;
      if (Object.keys(caseUpdate).length > 0 || decision.event) {
        const updated = await tx.case.update({
          where: { id: collectionCase.id },
          data: {
            ...caseUpdate,
            events: {
              create: decision.event ?? {
                actorType: "AI",
                type: CASE_EVENT_TYPES.emailReceived,
                note: safeClassification.summary,
                payload: {
                  communicationId: communication.id,
                  intent: safeClassification.intent
                }
              }
            }
          },
          select: { status: true }
        });
        updatedStatus = updated.status;
      }

      return {
        caseId: collectionCase.id,
        organizationId: collectionCase.organizationId,
        communicationId: communication.id,
        duplicate: false,
        appliedFields: decision.appliedFields,
        stillMissing: decision.stillMissing,
        status: updatedStatus,
        intent: safeClassification.intent,
        replySent: false
      };
    }).then(async (result) => {
      const refreshed = await prisma.case.findFirstOrThrow({
        where: { id: result.caseId ?? "", organizationId: result.organizationId },
        include: { debtor: true }
      });
      const actionResult = await applyCustomerAssistantAction({
        deps: this.deps,
        collectionCase: refreshed,
        classification: safeClassification,
        communicationId: result.communicationId
      });
      const afterAction = await prisma.case.findFirstOrThrow({
        where: { id: refreshed.id, organizationId: result.organizationId },
        include: {
          debtor: true,
          events: { orderBy: { createdAt: "desc" }, take: 8 }
        }
      });
      const template = chooseCustomerAssistantReply(
        afterAction,
        safeClassification,
        result.stillMissing,
        actionResult
      );
      await sendAssistantReply({
        deps: this.deps,
        caseId: afterAction.id,
        inboundCommunicationId: result.communicationId,
        to: email.from,
        template,
        idempotencyKey: `customer-assistant-reply:${email.provider}:${email.providerId}`
      });
      return { ...result, status: afterAction.status, replySent: true };
    });
  }
}

async function resolveCustomerAssistantCase(
  email: InboundEmail,
  route: EmailOrganizationRoute | undefined,
  ai: AiProvider
): Promise<CorrelationResult | null> {
  const secret = requireInboundReplyTokenSecret();
  for (const address of [...email.to, ...email.cc]) {
    const verified = verifyCaseClarificationAddress(address, secret);
    if (!verified) {
      continue;
    }
    const collectionCase = await prisma.case.findUnique({
      where: { id: verified.caseId },
      select: { id: true, organizationId: true }
    });
    if (collectionCase) {
      return {
        kind: "CASE",
        caseId: collectionCase.id,
        organizationId: collectionCase.organizationId,
        correlation: "SIGNED_CLARIFICATION_ADDRESS",
        matchedAddress: null
      };
    }
  }

  const threadIds = [email.inReplyTo, ...email.references]
    .map(normalizeMessageId)
    .filter((value): value is string => Boolean(value));
  if (threadIds.length > 0) {
    const outbound = await prisma.communication.findFirst({
      where: {
        direction: "OUTBOUND",
        OR: [
          { messageId: { in: threadIds } },
          { providerId: { in: threadIds } }
        ]
      },
      include: { case: true },
      orderBy: { createdAt: "desc" }
    });
    const raw = jsonRecord(outbound?.rawPayload);
    if (
      outbound &&
      (raw.kind === CUSTOMER_COMMUNICATION_KINDS.invoiceClarificationRequest ||
        raw.kind === CUSTOMER_COMMUNICATION_KINDS.emailAssistantReply ||
        raw.kind === CUSTOMER_COMMUNICATION_KINDS.multiAttachmentClarificationRequest)
    ) {
      return {
        kind: "CASE",
        caseId: outbound.caseId,
        organizationId: outbound.case.organizationId,
        correlation: "CUSTOMER_MESSAGE_THREAD",
        matchedAddress: null
      };
    }
  }

  if (!route) {
    return null;
  }

  const candidates = await findRecentCandidateCases(route.organizationId);
  if (candidates.length === 0) {
    return {
      kind: "AMBIGUOUS",
      organizationId: route.organizationId,
      matchedAddress: route.matchedAddress,
      reason: "NO_CASE_MATCH"
    };
  }

  const classification = await ai.classifyCustomerMessage({
    organizationId: route.organizationId,
    subject: email.subject,
    messageText: email.textBody ?? "",
    candidateCases: candidates
  });
  const matchedCaseId = cleanText(classification.caseReference.caseId);
  if (matchedCaseId) {
    const candidate = candidates.find((item) => item.caseId === matchedCaseId);
    if (candidate) {
      return {
        kind: "CASE",
        caseId: candidate.caseId,
        organizationId: route.organizationId,
        correlation: "CUSTOMER_ALIAS_REFERENCE",
        matchedAddress: route.matchedAddress,
        classification
      };
    }
  }

  const referenceMatched = matchCandidateByReference(candidates, classification);
  if (referenceMatched.length === 1) {
    return {
      kind: "CASE",
      caseId: referenceMatched[0]?.caseId ?? "",
      organizationId: route.organizationId,
      correlation: "CUSTOMER_ALIAS_REFERENCE",
      matchedAddress: route.matchedAddress,
      classification
    };
  }

  return {
    kind: "AMBIGUOUS",
    organizationId: route.organizationId,
    matchedAddress: route.matchedAddress,
    reason:
      referenceMatched.length > 1
        ? "MULTIPLE_CASES"
        : cleanText(email.textBody) || cleanText(email.subject)
          ? "NO_CASE_MATCH"
          : "NO_CASE_REFERENCE"
  };
}

async function classifyCustomerEmail(input: {
  ai: AiProvider;
  email: InboundEmail;
  organizationId: string;
  latestCaseSummary: string;
}): Promise<CustomerMessageClassification> {
  const classification = await input.ai.classifyCustomerMessage({
    organizationId: input.organizationId,
    subject: input.email.subject,
    messageText: stripQuotedEmailText(input.email.textBody ?? ""),
    latestCaseSummary: input.latestCaseSummary
  });

  return normalizeCustomerClassification(classification);
}

function normalizeCustomerClassification(
  classification: CustomerMessageClassification
): CustomerMessageClassification {
  if (
    classification.confidence < CUSTOMER_MESSAGE_CONFIDENCE_THRESHOLD ||
    classification.needsHumanReview
  ) {
    return {
      ...classification,
      needsHumanReview: true
    };
  }

  return classification;
}

function applySafeCustomerDecision(
  collectionCase: {
    id: string;
    organizationId: string;
    status: string;
    invoiceNumber: string | null;
    dueDate: Date | null;
    amountTotal: Prisma.Decimal | null;
    currency: string | null;
    debtorId: string | null;
    debtor: { id: string; name: string; email: string | null } | null;
    supplierSnapshot: Prisma.JsonValue | null;
    debtorSnapshot: Prisma.JsonValue | null;
    paymentSnapshot: Prisma.JsonValue | null;
    warnings: string[];
    automationPausedAt: Date | null;
  },
  classification: CustomerMessageClassification
): {
  caseUpdate?: Prisma.CaseUpdateInput;
  event?: Prisma.CaseEventCreateWithoutCaseInput;
  debtorPatch?: { name?: string; email?: string };
  appliedFields: string[];
  stillMissing: string[];
} {
  const safe = isSafeToApply(classification);
  const patch = safe ? buildCasePatch(collectionCase, classification) : {};
  const validation = validateInvoiceForWorkflow({
    invoiceNumber: patch.invoiceNumber ?? collectionCase.invoiceNumber,
    dueDate: patch.dueDate ?? collectionCase.dueDate,
    amountTotal:
      patch.amountTotal ??
      (collectionCase.amountTotal ? Number(collectionCase.amountTotal) : null),
    debtorName:
      patch.debtorName ?? collectionCase.debtor?.name ?? debtorSnapshotName(collectionCase),
    currency: patch.currency ?? collectionCase.currency,
    warnings: collectionCase.warnings
  });
  const stillMissing = validation.errors;
  const appliedFields = Object.keys(patch);
  const shouldRestoreParsed =
    appliedFields.length > 0 &&
    stillMissing.length === 0 &&
    ["RECEIVED", "PARSED", "MANUAL_REVIEW_REQUIRED"].includes(collectionCase.status) &&
    !collectionCase.automationPausedAt;

  if (!safe) {
    return {
      caseUpdate: {
        events: undefined
      },
      event: {
        actorType: "AI",
        type: CASE_EVENT_TYPES.manualReviewRequired,
        note: classification.summary,
        payload: {
          intent: classification.intent,
          requestedAction: classification.requestedAction,
          needsHumanReview: classification.needsHumanReview
        }
      },
      appliedFields: [],
      stillMissing
    };
  }

  const supplierSnapshot = {
    ...jsonRecord(collectionCase.supplierSnapshot),
    ...(patch.supplierName ? { name: patch.supplierName } : {})
  };
  const debtorSnapshot = {
    ...jsonRecord(collectionCase.debtorSnapshot),
    ...(patch.debtorName ? { name: patch.debtorName } : {}),
    ...(patch.debtorEmail ? { email: patch.debtorEmail } : {})
  };
  const paymentSnapshot = {
    ...jsonRecord(collectionCase.paymentSnapshot),
    ...(patch.iban ? { iban: patch.iban } : {}),
    ...(patch.variableSymbol ? { variableSymbol: patch.variableSymbol } : {})
  };

  const caseUpdate: Prisma.CaseUpdateInput = {
    status: shouldRestoreParsed ? "PARSED" : undefined,
    invoiceNumber: patch.invoiceNumber ?? undefined,
    dueDate: patch.dueDate ? parseIsoDate(patch.dueDate) : undefined,
    amountTotal: patch.amountTotal ?? undefined,
    currency: patch.currency ?? validation.currencyPatch ?? undefined,
    supplierSnapshot,
    debtorSnapshot,
    paymentSnapshot,
    warnings: validation.warningsPatch ?? collectionCase.warnings
  };

  return {
    caseUpdate,
    debtorPatch:
      patch.debtorName || patch.debtorEmail
        ? { name: patch.debtorName, email: patch.debtorEmail }
        : undefined,
    event: {
      actorType: "AI",
      type:
        appliedFields.length > 0
          ? CASE_EVENT_TYPES.statusChanged
          : classification.intent === "ADD_CASE_NOTE"
            ? CASE_EVENT_TYPES.emailReceived
            : CASE_EVENT_TYPES.emailReceived,
      note:
        classification.intent === "ADD_CASE_NOTE"
          ? cleanText(classification.customerNote) ?? classification.summary
          : appliedFields.length > 0
            ? `Customer assistant applied fields: ${appliedFields.join(", ")}.`
            : classification.summary,
      payload: {
        intent: classification.intent,
        appliedFields,
        stillMissing,
        customerNote: classification.customerNote,
        requestedAction: classification.requestedAction
      }
    },
    appliedFields,
    stillMissing
  };
}

function isSafeToApply(classification: CustomerMessageClassification): boolean {
  if (
    classification.confidence < CUSTOMER_MESSAGE_CONFIDENCE_THRESHOLD ||
    classification.needsHumanReview ||
    classification.intent === "UNSAFE_OR_LEGAL" ||
    MUTATING_INTENTS.has(classification.intent)
  ) {
    return false;
  }
  return true;
}

function buildCasePatch(
  collectionCase: {
    invoiceNumber: string | null;
    dueDate: Date | null;
    amountTotal: Prisma.Decimal | null;
    currency: string | null;
    debtor: { name: string; email: string | null } | null;
    supplierSnapshot: Prisma.JsonValue | null;
    debtorSnapshot: Prisma.JsonValue | null;
    paymentSnapshot: Prisma.JsonValue | null;
  },
  classification: CustomerMessageClassification
) {
  const extracted = classification.extractedInvoiceFields;
  const contact = classification.debtorContactPatch;
  const patch: {
    invoiceNumber?: string;
    dueDate?: string;
    amountTotal?: number;
    currency?: string;
    debtorName?: string;
    debtorEmail?: string;
    supplierName?: string;
    iban?: string;
    variableSymbol?: string;
  } = {};
  if (!cleanText(collectionCase.invoiceNumber) && cleanText(extracted.invoiceNumber)) {
    patch.invoiceNumber = cleanText(extracted.invoiceNumber) ?? undefined;
  }
  if (!collectionCase.dueDate && cleanText(extracted.dueDate)) {
    patch.dueDate = cleanText(extracted.dueDate) ?? undefined;
  }
  if (!collectionCase.amountTotal && extracted.amountTotal) {
    patch.amountTotal = extracted.amountTotal;
  }
  if (!cleanText(collectionCase.currency) && cleanText(extracted.currency)) {
    patch.currency = cleanText(extracted.currency)?.toUpperCase().slice(0, 3);
  }
  if (!collectionCase.debtor?.name && cleanText(extracted.debtorName)) {
    patch.debtorName = cleanText(extracted.debtorName) ?? undefined;
  }
  if (!collectionCase.debtor?.email) {
    const email = cleanText(extracted.debtorEmail) ?? cleanText(contact.email);
    if (email) {
      patch.debtorEmail = email.toLowerCase();
    }
  }
  if (!jsonString(collectionCase.supplierSnapshot, "name") && cleanText(extracted.supplierName)) {
    patch.supplierName = cleanText(extracted.supplierName) ?? undefined;
  }
  if (!jsonString(collectionCase.paymentSnapshot, "iban") && cleanText(extracted.iban)) {
    patch.iban = cleanText(extracted.iban)?.replace(/\s+/g, "").toUpperCase();
  }
  if (
    !jsonString(collectionCase.paymentSnapshot, "variableSymbol") &&
    cleanText(extracted.variableSymbol)
  ) {
    patch.variableSymbol = cleanText(extracted.variableSymbol)?.replace(/\s+/g, "");
  }
  return patch;
}

async function applyCustomerAssistantAction(input: {
  deps: CustomerEmailAssistantDependencies;
  collectionCase: {
    id: string;
    organizationId: string;
    status: string;
    workflowId: string | null;
    confirmedAt: Date | null;
    invoiceNumber: string | null;
    dueDate: Date | null;
    amountTotal: Prisma.Decimal | null;
    currency: string | null;
    warnings: string[];
    debtor: { id: string; name: string; email: string | null } | null;
  };
  classification: CustomerMessageClassification;
  communicationId: string | null;
}): Promise<CustomerAssistantActionResult> {
  if (
    input.classification.intent !== "REQUEST_CONFIRM_INVOICE" &&
    input.classification.intent !== "REQUEST_STANDARD_INSTALLMENT_PLAN" &&
    input.classification.intent !== "REQUEST_CUSTOM_INSTALLMENT_PLAN" &&
    input.classification.intent !== "REQUEST_SEND_DEBTOR_MESSAGE"
  ) {
    return { kind: "NONE" };
  }

  if (!isSafeToApply(input.classification)) {
    return {
      kind: "ACTION_BLOCKED",
      reason: "Požiadavka vyžaduje manuálne potvrdenie v dashboarde."
    };
  }

  if (input.classification.intent === "REQUEST_CONFIRM_INVOICE") {
    return confirmCaseFromCustomerEmail(input.collectionCase, input.communicationId);
  }

  if (input.classification.intent === "REQUEST_STANDARD_INSTALLMENT_PLAN") {
    return sendStandardInstallmentProposalFromCustomer(input);
  }

  return sendCustomerAuthorizedDebtorMessage(input);
}

async function confirmCaseFromCustomerEmail(
  collectionCase: {
    id: string;
    organizationId: string;
    status: string;
    confirmedAt: Date | null;
    invoiceNumber: string | null;
    dueDate: Date | null;
    amountTotal: Prisma.Decimal | null;
    currency: string | null;
    warnings: string[];
    debtor: { name: string; email: string | null } | null;
  },
  communicationId: string | null
): Promise<CustomerAssistantActionResult> {
  if (collectionCase.confirmedAt) {
    return { kind: "CASE_ALREADY_CONFIRMED" };
  }
  if (!["RECEIVED", "PARSED", "MANUAL_REVIEW_REQUIRED"].includes(collectionCase.status)) {
    return {
      kind: "ACTION_BLOCKED",
      reason: "Tento prípad už nie je v stave, ktorý možno spustiť emailom."
    };
  }

  const validation = validateInvoiceForWorkflow({
    invoiceNumber: collectionCase.invoiceNumber,
    dueDate: collectionCase.dueDate,
    amountTotal: collectionCase.amountTotal ? Number(collectionCase.amountTotal) : null,
    debtorName: collectionCase.debtor?.name ?? null,
    currency: collectionCase.currency,
    warnings: collectionCase.warnings
  });
  if (validation.errors.length > 0) {
    return {
      kind: "ACTION_BLOCKED",
      reason: `Prípad ešte nemožno spustiť. Chýba: ${validation.errors.join(", ")}`
    };
  }

  const changed = await prisma.case.updateMany({
    where: {
      id: collectionCase.id,
      organizationId: collectionCase.organizationId,
      confirmedAt: null,
      status: { in: ["RECEIVED", "PARSED", "MANUAL_REVIEW_REQUIRED"] }
    },
    data: {
      status: "WAITING_FOR_DUE_DATE",
      currency: collectionCase.currency ?? validation.currencyPatch,
      warnings: validation.warningsPatch ?? collectionCase.warnings,
      confirmedAt: new Date(),
      automationPausedAt: null,
      automationPauseReason: null
    }
  });
  if (changed.count !== 1) {
    return { kind: "CASE_ALREADY_CONFIRMED" };
  }

  const workflowId = `case-${collectionCase.id}`;
  await prisma.$transaction([
    prisma.caseEvent.create({
      data: {
        caseId: collectionCase.id,
        actorType: "AI",
        type: CASE_EVENT_TYPES.statusChanged,
        note: "Case confirmed from customer email.",
        payload: { communicationId }
      }
    }),
    prisma.caseEvent.create({
      data: {
        caseId: collectionCase.id,
        actorType: "SYSTEM",
        type: CASE_EVENT_TYPES.workflowWaiting,
        note: `Workflow start requested for ${workflowId}.`
      }
    })
  ]);

  return { kind: "CASE_CONFIRMED" };
}

async function sendStandardInstallmentProposalFromCustomer(input: {
  deps: CustomerEmailAssistantDependencies;
  collectionCase: {
    id: string;
    organizationId: string;
    status: string;
    confirmedAt: Date | null;
    invoiceNumber: string | null;
    amountTotal: Prisma.Decimal | null;
    currency: string | null;
    debtor: { id: string; name: string; email: string | null } | null;
  };
  communicationId: string | null;
}): Promise<CustomerAssistantActionResult> {
  const collectionCase = input.collectionCase;
  if (!collectionCase.confirmedAt) {
    return {
      kind: "ACTION_BLOCKED",
      reason: "Pred ponukou splátkového kalendára musí byť prípad spustený."
    };
  }
  if (!collectionCase.amountTotal) {
    return {
      kind: "ACTION_BLOCKED",
      reason: "Prípad nemá zadanú sumu dlhu."
    };
  }
  const debtorEmail = cleanText(collectionCase.debtor?.email);
  if (!debtorEmail) {
    return {
      kind: "ACTION_BLOCKED",
      reason: "Pri dlžníkovi chýba emailová adresa."
    };
  }

  const existing = await prisma.installmentPlan.findFirst({
    where: {
      caseId: collectionCase.id,
      status: { in: ["PROPOSED", "ACTIVE"] }
    },
    include: { payments: { orderBy: { sequence: "asc" } } }
  });
  if (existing) {
    return { kind: "INSTALLMENT_PROPOSAL_ALREADY_EXISTS" };
  }

  const allowedStatuses: CaseStatus[] = [
    "MANUAL_REVIEW_REQUIRED",
    "OVERDUE",
    "EMAIL_REMINDER_1_SENT",
    "EMAIL_REMINDER_2_SENT",
    "PAYMENT_PROMISED",
    "INSTALLMENT_REQUESTED"
  ];
  if (!allowedStatuses.includes(collectionCase.status as CaseStatus)) {
    return {
      kind: "ACTION_BLOCKED",
      reason:
        "Štandardný splátkový kalendár možno ponúknuť až po začatí inkasného prípadu alebo po reakcii dlžníka."
    };
  }
  if (collectionCase.status !== "MANUAL_REVIEW_REQUIRED") {
    assertCaseTransition(collectionCase.status as CaseStatus, "INSTALLMENT_PLAN_SENT");
  }

  const schedule = calculateInstallmentSchedule(
    Number(collectionCase.amountTotal),
    new Date()
  );
  const idempotencyKey = `customer-standard-installment-proposal:${collectionCase.id}:${input.communicationId ?? "manual"}`;
  const from = process.env.SES_FROM_EMAIL || "system@example.com";
  const replyTo = createCaseReplyAddress(
    { caseId: collectionCase.id, domain: inboundReplyDomain() },
    requireInboundReplyTokenSecret()
  );
  const invoiceNumber = collectionCase.invoiceNumber ?? collectionCase.id;
  const currency = collectionCase.currency ?? "EUR";
  const template = buildInstallmentProposal({
    invoiceNumber,
    currency,
    payments: schedule.map(installmentTemplateRow)
  });

  const created = await prisma.$transaction(async (tx) => {
    const plan = await tx.installmentPlan.create({
      data: {
        caseId: collectionCase.id,
        sourceCommunicationId: input.communicationId,
        totalAmount: collectionCase.amountTotal!,
        currency,
        payments: {
          create: schedule.map((payment) => ({
            sequence: payment.sequence,
            amount: payment.amount,
            dueDate: payment.dueDate
          }))
        }
      },
      include: { payments: { orderBy: { sequence: "asc" } } }
    });
    await tx.case.update({
      where: { id: collectionCase.id },
      data: {
        status: "INSTALLMENT_PLAN_SENT",
        nextActionAt: null,
        automationPausedAt: null,
        automationPauseReason: null
      }
    });
    await tx.caseEvent.create({
      data: {
        caseId: collectionCase.id,
        actorType: "AI",
        type: CASE_EVENT_TYPES.installmentProposed,
        note: "Customer authorized the standard three-payment installment proposal by email.",
        payload: {
          communicationId: input.communicationId,
          planId: plan.id,
          payments: schedule.map((payment) => ({
            sequence: payment.sequence,
            amount: payment.amount,
            dueDate: payment.dueDate.toISOString()
          }))
        }
      }
    });
    const communication = await tx.communication.create({
      data: {
        caseId: collectionCase.id,
        direction: "OUTBOUND",
        channel: "EMAIL",
        status: "DRAFT",
        idempotencyKey,
        fromAddress: from,
        toAddress: debtorEmail,
        subject: template.subject,
        textBody: template.textBody,
        htmlBody: template.htmlBody,
        rawPayload: {
          kind: "customer-authorized-installment-proposal",
          replyTo,
          planId: plan.id,
          sourceCommunicationId: input.communicationId
        }
      },
      select: { id: true }
    });
    return { planId: plan.id, communicationId: communication.id };
  });

  const sent = await input.deps.email.sendEmail({
    from,
    to: [debtorEmail],
    replyTo: [replyTo],
    subject: template.subject,
    textBody: template.textBody,
    htmlBody: template.htmlBody,
    metadata: {
      caseId: collectionCase.id,
      kind: "installment-proposal"
    }
  });

  await prisma.$transaction([
    prisma.communication.update({
      where: { id: created.communicationId },
      data: {
        status: "SENT",
        provider: sent.provider,
        providerId: sent.providerId,
        messageId: normalizeMessageId(sent.providerId),
        sentAt: new Date()
      }
    }),
    prisma.caseEvent.create({
      data: {
        caseId: collectionCase.id,
        actorType: "SYSTEM",
        type: CASE_EVENT_TYPES.emailSent,
        note: `Standard installment proposal sent to ${debtorEmail}.`,
        payload: {
          communicationId: created.communicationId,
          planId: created.planId
        }
      }
    })
  ]);

  return { kind: "INSTALLMENT_PROPOSAL_SENT" };
}

async function sendCustomerAuthorizedDebtorMessage(input: {
  deps: CustomerEmailAssistantDependencies;
  collectionCase: {
    id: string;
    organizationId: string;
    invoiceNumber: string | null;
    debtor: { id: string; name: string; email: string | null } | null;
  };
  classification: CustomerMessageClassification;
  communicationId: string | null;
}): Promise<CustomerAssistantActionResult> {
  const debtorEmail = cleanText(input.collectionCase.debtor?.email);
  if (!debtorEmail) {
    return {
      kind: "ACTION_BLOCKED",
      reason: "Pri dlžníkovi chýba emailová adresa."
    };
  }
  const message =
    cleanText(input.classification.replyDraft) ??
    cleanText(input.classification.requestedAction) ??
    cleanText(input.classification.customerNote);
  if (!message) {
    return {
      kind: "ACTION_BLOCKED",
      reason: "V pokyne chýba text správy pre dlžníka."
    };
  }

  const from = process.env.SES_FROM_EMAIL || "system@example.com";
  const replyTo = createCaseReplyAddress(
    { caseId: input.collectionCase.id, domain: inboundReplyDomain() },
    requireInboundReplyTokenSecret()
  );
  const invoiceNumber =
    input.collectionCase.invoiceNumber ?? input.collectionCase.id;
  const template = buildCustomerAuthorizedDebtorMessage({
    invoiceNumber,
    message
  });
  const idempotencyKey = `customer-authorized-debtor-message:${input.collectionCase.id}:${input.communicationId ?? "manual"}`;
  const communication =
    (await prisma.communication.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true }
    })) ??
    (await prisma.communication.create({
      data: {
        caseId: input.collectionCase.id,
        direction: "OUTBOUND",
        channel: "EMAIL",
        status: "DRAFT",
        idempotencyKey,
        fromAddress: from,
        toAddress: debtorEmail,
        subject: template.subject,
        textBody: template.textBody,
        htmlBody: template.htmlBody,
        rawPayload: {
          kind: "customer-authorized-debtor-message",
          replyTo,
          sourceCommunicationId: input.communicationId,
          intent: input.classification.intent
        }
      },
      select: { id: true, status: true }
    }));
  if (communication.status === "SENT") {
    return { kind: "DEBTOR_MESSAGE_SENT" };
  }

  const sent = await input.deps.email.sendEmail({
    from,
    to: [debtorEmail],
    replyTo: [replyTo],
    subject: template.subject,
    textBody: template.textBody,
    htmlBody: template.htmlBody,
    metadata: {
      caseId: input.collectionCase.id,
      kind: "customer-authorized-debtor-message"
    }
  });

  await prisma.$transaction([
    prisma.communication.update({
      where: { id: communication.id },
      data: {
        status: "SENT",
        provider: sent.provider,
        providerId: sent.providerId,
        messageId: normalizeMessageId(sent.providerId),
        sentAt: new Date()
      }
    }),
    prisma.caseEvent.create({
      data: {
        caseId: input.collectionCase.id,
        actorType: "AI",
        type: CASE_EVENT_TYPES.emailSent,
        note: "Customer-authorized message sent to debtor.",
        payload: {
          communicationId: communication.id,
          sourceCommunicationId: input.communicationId,
          intent: input.classification.intent
        }
      }
    })
  ]);

  return { kind: "DEBTOR_MESSAGE_SENT" };
}

function chooseCustomerAssistantReply(
  collectionCase: {
    id: string;
    organizationId: string;
    invoiceNumber: string | null;
    status: string;
    dueDate: Date | null;
    amountTotal: Prisma.Decimal | null;
    currency: string | null;
    debtor: { name: string; email: string | null } | null;
    events?: Array<{ type: string; note: string | null; createdAt: Date }>;
  },
  classification: CustomerMessageClassification,
  stillMissing: string[],
  actionResult: CustomerAssistantActionResult = { kind: "NONE" }
) {
  if (actionResult.kind === "CASE_CONFIRMED") {
    return buildCustomerAssistantAcknowledgement({
      invoiceNumber: collectionCase.invoiceNumber,
      summary:
        "Prípad sme potvrdili a spustili automatickú kontrolu splatnosti.",
      stillMissing: [],
      dashboardUrl: dashboardUrl(collectionCase.id)
    });
  }

  if (actionResult.kind === "CASE_ALREADY_CONFIRMED") {
    return buildCustomerAssistantAcknowledgement({
      invoiceNumber: collectionCase.invoiceNumber,
      summary: "Prípad už bol spustený. Automatizácia pokračuje podľa aktuálneho stavu.",
      stillMissing: [],
      dashboardUrl: dashboardUrl(collectionCase.id)
    });
  }

  if (actionResult.kind === "INSTALLMENT_PROPOSAL_SENT") {
    return buildCustomerAssistantAcknowledgement({
      invoiceNumber: collectionCase.invoiceNumber,
      summary:
        "Štandardný splátkový kalendár sme poslali dlžníkovi na výslovné potvrdenie.",
      stillMissing: [],
      dashboardUrl: dashboardUrl(collectionCase.id)
    });
  }

  if (actionResult.kind === "INSTALLMENT_PROPOSAL_ALREADY_EXISTS") {
    return buildCustomerAssistantAcknowledgement({
      invoiceNumber: collectionCase.invoiceNumber,
      summary:
        "Splátkový kalendár už je k prípadu pripravený alebo aktívny.",
      stillMissing: [],
      dashboardUrl: dashboardUrl(collectionCase.id)
    });
  }

  if (actionResult.kind === "DEBTOR_MESSAGE_SENT") {
    return buildCustomerAssistantAcknowledgement({
      invoiceNumber: collectionCase.invoiceNumber,
      summary: "Správu sme podľa vášho pokynu odoslali dlžníkovi.",
      stillMissing: [],
      dashboardUrl: dashboardUrl(collectionCase.id)
    });
  }

  if (actionResult.kind === "ACTION_BLOCKED") {
    return buildCustomerActionNeedsConfirmation({
      invoiceNumber: collectionCase.invoiceNumber,
      requestedAction: actionResult.reason,
      dashboardUrl: dashboardUrl(collectionCase.id)
    });
  }

  if (!isSafeToApply(classification)) {
    if (MUTATING_INTENTS.has(classification.intent)) {
      return buildCustomerActionNeedsConfirmation({
        invoiceNumber: collectionCase.invoiceNumber,
        requestedAction:
          cleanText(classification.requestedAction) ?? classification.summary,
        dashboardUrl: dashboardUrl(collectionCase.id)
      });
    }
    return buildCustomerManualReviewEscalation({
      invoiceNumber: collectionCase.invoiceNumber,
      summary: classification.summary,
      dashboardUrl: dashboardUrl(collectionCase.id)
    });
  }

  const confirmUrl = customerAskedForReviewEmail(classification)
    ? buildConfirmUrlIfReady(collectionCase)
    : null;
  if (confirmUrl) {
    return buildCustomerCaseStatusReply({
      invoiceNumber: collectionCase.invoiceNumber,
      status: collectionCase.status,
      amountTotal: collectionCase.amountTotal ? Number(collectionCase.amountTotal) : null,
      currency: collectionCase.currency,
      dueDate: collectionCase.dueDate?.toISOString().slice(0, 10) ?? null,
      debtorName: collectionCase.debtor?.name ?? null,
      confirmUrl,
      dashboardUrl: dashboardUrl(collectionCase.id)
    });
  }

  if (
    classification.intent === "ASK_CASE_STATUS" ||
    classification.intent === "ASK_CASE_HISTORY"
  ) {
    return buildCustomerCaseStatusReply({
      invoiceNumber: collectionCase.invoiceNumber,
      status: collectionCase.status,
      amountTotal: collectionCase.amountTotal ? Number(collectionCase.amountTotal) : null,
      currency: collectionCase.currency,
      dueDate: collectionCase.dueDate?.toISOString().slice(0, 10) ?? null,
      debtorName: collectionCase.debtor?.name ?? null,
      recentEvents: summarizeRecentEvents(collectionCase.events ?? []),
      dashboardUrl: dashboardUrl(collectionCase.id)
    });
  }

  if (customerAskedForReviewEmail(classification)) {
    return buildCustomerCaseStatusReply({
      invoiceNumber: collectionCase.invoiceNumber,
      status: collectionCase.status,
      amountTotal: collectionCase.amountTotal ? Number(collectionCase.amountTotal) : null,
      currency: collectionCase.currency,
      dueDate: collectionCase.dueDate?.toISOString().slice(0, 10) ?? null,
      debtorName: collectionCase.debtor?.name ?? null,
      dashboardUrl: dashboardUrl(collectionCase.id)
    });
  }

  if (stillMissing.length > 0) {
    return buildCustomerMissingFieldsFollowUp({
      invoiceNumber: collectionCase.invoiceNumber,
      stillMissing,
      dashboardUrl: dashboardUrl(collectionCase.id)
    });
  }

  return buildCustomerAssistantAcknowledgement({
    invoiceNumber: collectionCase.invoiceNumber,
    summary: classification.summary,
    stillMissing,
    dashboardUrl: dashboardUrl(collectionCase.id)
  });
}

function buildConfirmUrlIfReady(collectionCase: {
  id?: string;
  organizationId?: string;
  status: string;
  invoiceNumber: string | null;
  dueDate: Date | null;
  amountTotal: Prisma.Decimal | null;
  currency: string | null;
  debtor: { name: string; email: string | null } | null;
}) {
  if (
    !collectionCase.id ||
    !collectionCase.organizationId ||
    !["PARSED", "MANUAL_REVIEW_REQUIRED", "RECEIVED"].includes(collectionCase.status)
  ) {
    return null;
  }
  const validation = validateInvoiceForWorkflow({
    invoiceNumber: collectionCase.invoiceNumber,
    dueDate: collectionCase.dueDate,
    amountTotal: collectionCase.amountTotal ? Number(collectionCase.amountTotal) : null,
    debtorName: collectionCase.debtor?.name ?? null,
    currency: collectionCase.currency,
    warnings: []
  });
  if (validation.errors.length > 0) {
    return null;
  }
  return `${appBaseUrl()}/api/cases/${encodeURIComponent(collectionCase.id)}/confirm-link?token=${encodeURIComponent(createCaseConfirmTokenForEmail(collectionCase.id, collectionCase.organizationId))}`;
}

function createCaseConfirmTokenForEmail(caseId: string, organizationId: string): string {
  return createCaseConfirmToken(
    {
      caseId,
      organizationId,
      expiresAt: Date.now() + CASE_CONFIRM_TOKEN_DEFAULT_TTL_MS
    },
    requireCaseConfirmTokenSecret()
  );
}

function appBaseUrl(): string {
  const value =
    process.env.APP_BASE_URL ||
    process.env.NEXTAUTH_URL ||
    process.env.AUTH_URL ||
    "http://localhost:3000";
  return value.replace(/\/+$/u, "");
}

function dashboardUrl(caseId: string): string {
  return `${appBaseUrl()}/?case=${encodeURIComponent(caseId)}`;
}

function customerAskedForReviewEmail(
  classification: CustomerMessageClassification
): boolean {
  const requested = normalizeKey(classification.requestedAction);
  const note = normalizeKey(classification.customerNote);
  const summary = normalizeKey(classification.summary);
  return (
    Boolean(requested?.includes("kontrol")) ||
    Boolean(requested?.includes("check")) ||
    Boolean(requested?.includes("send details")) ||
    Boolean(requested?.includes("poslite")) ||
    Boolean(requested?.includes("pošlite")) ||
    Boolean(note?.includes("kontrol")) ||
    Boolean(summary?.includes("kontrol"))
  );
}

function installmentTemplateRow(payment: {
  sequence: number;
  amount: number;
  dueDate: Date;
}) {
  return {
    sequence: payment.sequence,
    amount: payment.amount,
    dueDate: payment.dueDate.toISOString().slice(0, 10)
  };
}

function summarizeRecentEvents(
  events: Array<{ type: string; note: string | null; createdAt: Date }>
): string[] {
  return events
    .slice(0, 6)
    .map((event) => {
      const date = new Intl.DateTimeFormat("sk-SK", {
        day: "numeric",
        month: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Bratislava"
      }).format(event.createdAt);
      return `${date}: ${event.note || event.type}`;
    });
}

async function sendAssistantReply(input: {
  deps: CustomerEmailAssistantDependencies;
  caseId: string;
  inboundCommunicationId: string | null;
  to: string;
  template: ReturnType<typeof buildCustomerAssistantAcknowledgement>;
  idempotencyKey: string;
}): Promise<void> {
  const to = cleanText(input.to);
  if (!to) {
    return;
  }
  const existing = await prisma.communication.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, status: true }
  });
  if (existing?.status === "SENT") {
    return;
  }

  const from = process.env.SES_FROM_EMAIL || "system@example.com";
  const replyTo = createCaseClarificationAddress(
    { caseId: input.caseId, domain: inboundReplyDomain() },
    requireInboundReplyTokenSecret()
  );
  const communication =
    existing ??
    (await prisma.communication.create({
      data: {
        caseId: input.caseId,
        direction: "OUTBOUND",
        channel: "EMAIL",
        status: "DRAFT",
        idempotencyKey: input.idempotencyKey,
        fromAddress: from,
        toAddress: to,
        subject: input.template.subject,
        textBody: input.template.textBody,
        htmlBody: input.template.htmlBody,
        rawPayload: {
          kind: CUSTOMER_COMMUNICATION_KINDS.emailAssistantReply,
          inboundCommunicationId: input.inboundCommunicationId,
          replyTo
        }
      },
      select: { id: true, status: true }
    }));

  const sent = await input.deps.email.sendEmail({
    from,
    to: [to],
    replyTo: [replyTo],
    subject: input.template.subject,
    textBody: input.template.textBody,
    htmlBody: input.template.htmlBody,
    metadata: {
      caseId: input.caseId,
      kind: "customer-assistant"
    }
  });

  await prisma.$transaction([
    prisma.communication.update({
      where: { id: communication.id },
      data: {
        status: "SENT",
        provider: sent.provider,
        providerId: sent.providerId,
        messageId: normalizeMessageId(sent.providerId),
        sentAt: new Date()
      }
    }),
    prisma.caseEvent.create({
      data: {
        caseId: input.caseId,
        actorType: "SYSTEM",
        type: CASE_EVENT_TYPES.emailSent,
        note: `Customer assistant reply sent to ${to}.`,
        payload: {
          communicationId: communication.id,
          inboundCommunicationId: input.inboundCommunicationId
        }
      }
    })
  ]);
}

async function sendUnmatchedFollowUp(input: {
  deps: CustomerEmailAssistantDependencies;
  email: InboundEmail;
  organizationId: string;
  matchedAddress: string | null;
  reason: string;
}): Promise<{
  caseId: string;
  communicationId: string;
  duplicate: boolean;
  replySent: boolean;
}> {
  const inboundIdempotencyKey = `customer-assistant-unmatched-inbound:${input.email.provider}:${input.email.providerId}`;
  const existing = await prisma.communication.findUnique({
    where: { idempotencyKey: inboundIdempotencyKey },
    include: { case: true }
  });

  const stored =
    existing ??
    (await prisma.$transaction(async (tx) => {
      const collectionCase = await tx.case.create({
        data: {
          organizationId: input.organizationId,
          sourceType: "EMAIL",
          status: "MANUAL_REVIEW_REQUIRED",
          subjectNote:
            cleanText(input.email.subject) ??
            "Unmatched customer assistant message"
        },
        select: { id: true, organizationId: true, status: true }
      });
      const communication = await tx.communication.create({
        data: {
          caseId: collectionCase.id,
          direction: "INBOUND",
          channel: "EMAIL",
          status: "RECEIVED",
          idempotencyKey: inboundIdempotencyKey,
          provider: input.email.provider,
          providerId: input.email.providerId,
          messageId: normalizeMessageId(input.email.messageId),
          inReplyTo: normalizeMessageId(input.email.inReplyTo),
          references: input.email.references
            .map(normalizeMessageId)
            .filter((value): value is string => Boolean(value)),
          fromAddress: input.email.from,
          toAddress: input.email.to.join(", "),
          subject: input.email.subject,
          textBody: input.email.textBody,
          htmlBody: input.email.htmlBody,
          rawPayload: {
            kind: CUSTOMER_COMMUNICATION_KINDS.unmatchedAssistantMessage,
            reason: input.reason,
            matchedAddress: input.matchedAddress
          },
          receivedAt: new Date()
        },
        include: { case: true }
      });
      await tx.caseEvent.create({
        data: {
          caseId: collectionCase.id,
          actorType: "SYSTEM",
          type: CASE_EVENT_TYPES.manualReviewRequired,
          note:
            "Customer assistant could not match this email to exactly one case.",
          payload: {
            communicationId: communication.id,
            reason: input.reason,
            matchedAddress: input.matchedAddress
          }
        }
      });
      return communication;
    }));

  const template = buildCustomerAmbiguousCaseFollowUp({
    matchedAddress: input.matchedAddress
  });
  await sendAssistantReply({
    deps: input.deps,
    caseId: stored.caseId,
    inboundCommunicationId: stored.id,
    to: input.email.from,
    template,
    idempotencyKey: `customer-assistant-unmatched-reply:${input.email.provider}:${input.email.providerId}`
  });
  return {
    caseId: stored.caseId,
    communicationId: stored.id,
    duplicate: Boolean(existing),
    replySent: true
  };
}

async function findRecentCandidateCases(organizationId: string): Promise<CustomerCandidateCase[]> {
  const cases = await prisma.case.findMany({
    where: { organizationId },
    include: { debtor: true },
    orderBy: { updatedAt: "desc" },
    take: 25
  });
  return cases.map((item) => ({
    caseId: item.id,
    invoiceNumber: item.invoiceNumber,
    debtorName: item.debtor?.name ?? jsonString(item.debtorSnapshot, "name"),
    amountTotal: item.amountTotal ? Number(item.amountTotal) : null,
    currency: item.currency,
    status: item.status
  }));
}

function matchCandidateByReference(
  candidates: CustomerCandidateCase[],
  classification: CustomerMessageClassification
) {
  const invoice = normalizeKey(classification.caseReference.invoiceNumber);
  const debtor = normalizeKey(classification.caseReference.debtorName);
  return candidates.filter((candidate) => {
    const invoiceMatches =
      invoice && normalizeKey(candidate.invoiceNumber) === invoice;
    const debtorMatches =
      debtor && normalizeKey(candidate.debtorName) === debtor;
    return invoiceMatches || debtorMatches;
  });
}

function mergeDeterministicFieldExtraction(
  text: string,
  classification: CustomerMessageClassification
): CustomerMessageClassification {
  const deterministic = extractCustomerClarificationFields(text);
  return {
    ...classification,
    extractedInvoiceFields: {
      ...classification.extractedInvoiceFields,
      ...withoutNullish(deterministic)
    }
  };
}

export function extractCustomerClarificationFields(
  text: string
): CustomerMessageClassification["extractedInvoiceFields"] {
  const fields = emptyCustomerExtractedInvoiceFields();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:=-]{2,40})\s*[:=-]\s*(.+?)\s*$/u);
    if (!match) {
      continue;
    }
    const label = normalizeLabel(match[1] ?? "");
    const value = cleanText(match[2]);
    if (!value) {
      continue;
    }

    if (/(cislo|číslo|faktura|faktúra|invoice)/u.test(label)) {
      fields.invoiceNumber = cleanIdentifier(value);
    } else if (/(splatnost|splatnosť|due)/u.test(label)) {
      fields.dueDate = normalizeDate(value);
    } else if (/(suma|amount|celkom)/u.test(label)) {
      fields.amountTotal = normalizeAmount(value);
    } else if (/(mena|currency)/u.test(label)) {
      fields.currency = value.toUpperCase().slice(0, 3);
    } else if (/(odberatel|odberateľ|dlznik|dlžnik|dlžník|debtor)/u.test(label)) {
      fields.debtorName = value;
    } else if (/email/u.test(label)) {
      fields.debtorEmail = value.toLowerCase();
    } else if (/(dodavatel|dodávateľ|supplier|veritel|veriteľ)/u.test(label)) {
      fields.supplierName = value;
    } else if (/iban/u.test(label)) {
      fields.iban = value.replace(/\s+/g, "").toUpperCase();
    } else if (/(variabilny|variabilný|vs|symbol)/u.test(label)) {
      fields.variableSymbol = value.replace(/\s+/g, "");
    }
  }
  return fields;
}

export function stripQuotedEmailText(text: string): string {
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(">")) {
      break;
    }
    if (/^on .+ wrote:$/i.test(trimmed)) {
      break;
    }
    if (/^\w{2}\s+\d{1,2}\.\s*\d{1,2}\.\s*\d{4}.*nap[ií]sal/i.test(trimmed)) {
      break;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function summarizeCaseForAi(collectionCase: {
  id: string;
  status: string;
  invoiceNumber: string | null;
  dueDate: Date | null;
  amountTotal: Prisma.Decimal | null;
  currency: string | null;
  debtor: { name: string; email: string | null } | null;
  events: Array<{ type: string; note: string | null; createdAt: Date }>;
}) {
  return [
    `caseId: ${collectionCase.id}`,
    `status: ${collectionCase.status}`,
    `invoiceNumber: ${collectionCase.invoiceNumber ?? "(missing)"}`,
    `debtor: ${collectionCase.debtor?.name ?? "(missing)"}`,
    `debtorEmail: ${collectionCase.debtor?.email ?? "(missing)"}`,
    `amount: ${
      collectionCase.amountTotal ? Number(collectionCase.amountTotal) : "(missing)"
    } ${collectionCase.currency ?? ""}`.trim(),
    `dueDate: ${collectionCase.dueDate?.toISOString().slice(0, 10) ?? "(missing)"}`,
    "recent events:",
    ...collectionCase.events.map((event) => `${event.createdAt.toISOString()} ${event.type}: ${event.note ?? ""}`)
  ].join("\n");
}

function normalizeDate(value: string): string | null {
  const iso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const slovak = value.match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\b/);
  if (slovak) {
    const day = slovak[1]?.padStart(2, "0");
    const month = slovak[2]?.padStart(2, "0");
    return `${slovak[3]}-${month}-${day}`;
  }
  return null;
}

function normalizeAmount(value: string): number | null {
  const match = value.replace(/\s+/g, "").match(/-?\d+(?:[,.]\d{1,2})?/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[0].replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function inboundReplyDomain(): string {
  const domain = process.env.INBOUND_REPLY_DOMAIN;
  if (domain?.trim()) {
    return domain.trim().toLowerCase();
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("INBOUND_REPLY_DOMAIN is required in production.");
  }
  return "reply.fakturio.local";
}

function cleanIdentifier(value: string): string {
  return value.trim().replace(/[.,;:]+$/u, "");
}

function debtorSnapshotName(collectionCase: { debtorSnapshot: Prisma.JsonValue | null }) {
  return jsonString(collectionCase.debtorSnapshot, "name");
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonString(value: unknown, key: string): string | null {
  const item = jsonRecord(value)[key];
  return typeof item === "string" ? cleanText(item) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? cleanText(value) : null;
}

function normalizeLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function normalizeKey(value: string | null | undefined): string | null {
  return cleanText(value)
    ?.toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ") ?? null;
}

function normalizeMessageId(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^<|>$/g, "").toLowerCase();
  return normalized || null;
}

function withoutNullish<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined)
  ) as Partial<T>;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createAiProvider } from "@fakturio/ai";
import { prisma } from "@fakturio/db";
import type { InboundEmail } from "@fakturio/email";
import {
  CASE_EVENT_TYPES,
  requireInboundReplyTokenSecret,
  verifyCaseReplyAddress,
  type AiProvider,
  type DebtorReplyClassification
} from "@fakturio/shared";

export type DebtorReplyResult = {
  caseId: string;
  organizationId: string;
  communicationId: string;
  classification: DebtorReplyClassification | null;
  classificationPending: boolean;
  duplicate: boolean;
};

export class DebtorReplyService {
  constructor(private readonly ai: AiProvider = createAiProvider()) {}

  async process(email: InboundEmail): Promise<DebtorReplyResult | null> {
    const matched = await resolveInboundReplyCase(email);
    if (!matched) {
      return null;
    }

    const idempotencyKey = `inbound-reply:${email.provider}:${email.providerId}`;
    let communication = await prisma.communication.findUnique({
      where: { idempotencyKey }
    });
    let duplicate = Boolean(communication);

    if (!communication) {
      try {
        communication = await prisma.$transaction(async (tx) => {
          const created = await tx.communication.create({
            data: {
              caseId: matched.caseId,
              direction: "INBOUND",
              channel: "EMAIL",
              status: "RECEIVED",
              idempotencyKey,
              provider: email.provider,
              providerId: email.providerId,
              messageId: normalizeMessageId(email.messageId),
              inReplyTo: normalizeMessageId(email.inReplyTo),
              references: email.references.map(normalizeMessageId).filter((value): value is string => Boolean(value)),
              fromAddress: email.from,
              toAddress: email.to.join(", "),
              subject: email.subject,
              textBody: email.textBody,
              htmlBody: email.htmlBody,
              rawPayload: safeEmailRaw(email),
              receivedAt: new Date()
            }
          });

          await tx.caseEvent.create({
            data: {
              caseId: matched.caseId,
              actorType: "EMAIL_PROVIDER",
              type: CASE_EVENT_TYPES.emailReceived,
              note: `Inbound debtor email received from ${email.from}.`,
              payload: {
                communicationId: created.id,
                correlation: matched.correlation,
                senderMatchesDebtor: matched.debtorEmail
                  ? matched.debtorEmail.toLowerCase() === email.from.toLowerCase()
                  : null
              }
            }
          });

          return created;
        });
      } catch (error) {
        if (!isUniqueConstraintViolation(error)) {
          throw error;
        }
        communication = await prisma.communication.findUniqueOrThrow({
          where: { idempotencyKey }
        });
        duplicate = true;
      }
    }

    const existingClassification = parseStoredClassification(
      communication.aiClassification
    );
    if (existingClassification) {
      return {
        caseId: matched.caseId,
        organizationId: matched.organizationId,
        communicationId: communication.id,
        classification: existingClassification,
        classificationPending: false,
        duplicate: true
      };
    }

    const classificationLeaseId = randomUUID();
    const classificationLeaseUntil = new Date(Date.now() + 2 * 60_000);
    const claimed = await prisma.communication.updateMany({
      where: {
        id: communication.id,
        aiClassification: { equals: Prisma.DbNull },
        OR: [
          { classificationLeaseUntil: null },
          { classificationLeaseUntil: { lt: new Date() } }
        ]
      },
      data: {
        classificationLeaseId,
        classificationLeaseUntil
      }
    });

    if (claimed.count !== 1) {
      const current = await prisma.communication.findUniqueOrThrow({
        where: { id: communication.id }
      });
      return {
        caseId: matched.caseId,
        organizationId: matched.organizationId,
        communicationId: communication.id,
        classification: parseStoredClassification(current.aiClassification),
        classificationPending: true,
        duplicate: true
      };
    }

    const messageText = email.textBody?.trim() || stripHtml(email.htmlBody);
    let classification: DebtorReplyClassification;
    try {
      classification = messageText
        ? await this.ai.classifyDebtorReply({
            caseId: matched.caseId,
            messageText,
            latestCaseSummary: matched.caseSummary
          })
        : {
            intent: "NEEDS_HUMAN" as const,
            promisedPaymentDate: null,
            installmentRequested: false,
            summary: "Inbound reply did not contain a readable text body.",
            confidence: 1,
            warnings: ["Message requires manual review because no readable body was found."]
          };

      await prisma.$transaction(async (tx) => {
        const updated = await tx.communication.updateMany({
          where: {
            id: communication.id,
            classificationLeaseId
          },
          data: {
            aiClassification: classification as unknown as Prisma.InputJsonValue,
            classificationLeaseId: null,
            classificationLeaseUntil: null
          }
        });
        if (updated.count !== 1) {
          throw new Error(
            `Classification lease for communication ${communication.id} was lost.`
          );
        }

        await tx.caseEvent.create({
          data: {
            caseId: matched.caseId,
            actorType: "AI",
            type: CASE_EVENT_TYPES.debtorReplyClassified,
            note: `Debtor reply classified as ${classification.intent}. No case status was changed automatically.`,
            payload: {
              communicationId: communication.id,
              classification: classification as unknown as Prisma.InputJsonValue
            }
          }
        });
      });
    } catch (error) {
      await prisma.communication
        .updateMany({
          where: { id: communication.id, classificationLeaseId },
          data: {
            classificationLeaseId: null,
            classificationLeaseUntil: null
          }
        })
        .catch(() => undefined);
      throw error;
    }

    return {
      caseId: matched.caseId,
      organizationId: matched.organizationId,
      communicationId: communication.id,
      classification,
      classificationPending: false,
      duplicate
    };
  }
}

async function resolveInboundReplyCase(email: InboundEmail): Promise<{
  caseId: string;
  organizationId: string;
  debtorEmail: string | null;
  caseSummary: string;
  correlation: "SIGNED_REPLY_ADDRESS" | "MESSAGE_THREAD";
} | null> {
  const secret = requireInboundReplyTokenSecret();

  for (const address of [...email.to, ...email.cc]) {
    const verified = verifyCaseReplyAddress(address, secret);
    if (!verified) {
      continue;
    }

    const collectionCase = await prisma.case.findUnique({
      where: { id: verified.caseId },
      include: {
        debtor: true,
        events: { orderBy: { createdAt: "desc" }, take: 6 }
      }
    });
    if (collectionCase) {
      return summarizeMatch(collectionCase, "SIGNED_REPLY_ADDRESS");
    }
  }

  const threadIds = [email.inReplyTo, ...email.references]
    .map(normalizeMessageId)
    .filter((value): value is string => Boolean(value));
  if (threadIds.length === 0) {
    return null;
  }

  const outbound = await prisma.communication.findFirst({
    where: {
      direction: "OUTBOUND",
      OR: [
        { messageId: { in: threadIds } },
        { providerId: { in: threadIds } }
      ]
    },
    include: {
      case: {
        include: {
          debtor: true,
          events: { orderBy: { createdAt: "desc" }, take: 6 }
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });

  return outbound
    ? summarizeMatch(outbound.case, "MESSAGE_THREAD")
    : null;
}

function summarizeMatch(
  collectionCase: {
    id: string;
    organizationId: string;
    invoiceNumber: string | null;
    amountTotal: Prisma.Decimal | null;
    currency: string | null;
    dueDate: Date | null;
    status: string;
    debtor: { name: string; email: string | null } | null;
    events: Array<{ type: string; note: string | null }>;
  },
  correlation: "SIGNED_REPLY_ADDRESS" | "MESSAGE_THREAD"
) {
  const caseSummary = [
    `Invoice: ${collectionCase.invoiceNumber ?? "unknown"}`,
    `Debtor: ${collectionCase.debtor?.name ?? "unknown"}`,
    `Amount: ${collectionCase.amountTotal?.toString() ?? "unknown"} ${collectionCase.currency ?? ""}`.trim(),
    `Due date: ${collectionCase.dueDate?.toISOString().slice(0, 10) ?? "unknown"}`,
    `Current status: ${collectionCase.status}`,
    ...collectionCase.events.map((event) => `${event.type}: ${event.note ?? ""}`)
  ].join("\n");

  return {
    caseId: collectionCase.id,
    organizationId: collectionCase.organizationId,
    debtorEmail: collectionCase.debtor?.email ?? null,
    caseSummary,
    correlation
  };
}

function safeEmailRaw(email: InboundEmail): Prisma.InputJsonObject {
  return {
    provider: email.provider,
    providerId: email.providerId,
    messageId: email.messageId,
    inReplyTo: email.inReplyTo,
    references: email.references,
    from: email.from,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    attachmentNames: email.attachments.map((attachment) => attachment.fileName)
  };
}

function parseStoredClassification(
  value: Prisma.JsonValue | null
): DebtorReplyClassification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.intent !== "string" ||
    typeof candidate.summary !== "string" ||
    typeof candidate.confidence !== "number" ||
    !Array.isArray(candidate.warnings)
  ) {
    return null;
  }
  return value as unknown as DebtorReplyClassification;
}

function normalizeMessageId(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^<|>$/g, "").toLowerCase();
  return normalized || null;
}

function stripHtml(value: string | null): string {
  return value?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "";
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

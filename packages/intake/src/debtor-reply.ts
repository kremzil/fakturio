import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@fakturio/db";
import type { InboundEmail, InboundEmailAttachment } from "@fakturio/email";
import {
  createStorageProvider,
  type StorageProvider
} from "@fakturio/storage";
import {
  CASE_EVENT_TYPES,
  requireInboundReplyTokenSecret,
  verifyCaseReplyAddress,
  WORKFLOW_COMMAND_TYPES,
  type DebtorReplyClassification
} from "@fakturio/shared";
import {
  selectReplyAttachments,
  type RejectedReplyAttachment
} from "./reply-attachment-policy";

export type DebtorReplyResult = {
  caseId: string;
  organizationId: string;
  communicationId: string;
  classification: DebtorReplyClassification | null;
  classificationPending: boolean;
  duplicate: boolean;
};

export class DebtorReplyService {
  constructor(
    private readonly storage: StorageProvider = createStorageProvider()
  ) {}

  async process(email: InboundEmail): Promise<DebtorReplyResult | null> {
    const matched = await resolveInboundReplyCase(email);
    if (!matched) {
      return null;
    }

    const attachmentSelection = selectReplyAttachments(email.attachments);
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
              references: email.references
                .map(normalizeMessageId)
                .filter((value): value is string => Boolean(value)),
              fromAddress: email.from,
              toAddress: email.to.join(", "),
              subject: email.subject,
              textBody: email.textBody,
              htmlBody: email.htmlBody,
              rawPayload: safeEmailRaw(email, attachmentSelection.rejected),
              receivedAt: new Date()
            }
          });

          const senderMatchesDebtor = matched.debtorEmail
            ? matched.debtorEmail.toLowerCase() === email.from.toLowerCase()
            : false;
          const receivedEvent = await tx.caseEvent.create({
            data: {
              caseId: matched.caseId,
              actorType: "EMAIL_PROVIDER",
              type: CASE_EVENT_TYPES.emailReceived,
              note: `Inbound debtor email received from ${email.from}.`,
              payload: {
                communicationId: created.id,
                correlation: matched.correlation,
                senderMatchesDebtor,
                automated: isAutomatedEmail(email)
              }
            }
          });

          await tx.workflowCommand.create({
            data: {
              caseId: matched.caseId,
              organizationId: matched.organizationId,
              type: WORKFLOW_COMMAND_TYPES.debtorReplyReceived,
              idempotencyKey: `debtor-reply:${receivedEvent.id}`,
              payload: { communicationId: created.id }
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

    await this.persistAttachments(
      matched.organizationId,
      matched.caseId,
      communication.id,
      attachmentSelection.accepted
    );

    const classification = parseStoredClassification(
      communication.aiClassification
    );
    return {
      caseId: matched.caseId,
      organizationId: matched.organizationId,
      communicationId: communication.id,
      classification,
      classificationPending: !classification,
      duplicate
    };
  }

  private async persistAttachments(
    organizationId: string,
    caseId: string,
    communicationId: string,
    attachments: InboundEmailAttachment[]
  ): Promise<void> {
    for (const attachment of attachments) {
      const sha256 = createHash("sha256")
        .update(attachment.bytes)
        .digest("hex");
      const existing = await prisma.communicationAttachment.findFirst({
        where: {
          communicationId,
          sha256,
          originalName: attachment.fileName
        },
        select: { id: true }
      });
      if (existing) {
        continue;
      }

      const stored = await this.storage.putObject({
        organizationId,
        caseId,
        fileName: attachment.fileName,
        contentType: attachment.mimeType,
        body: attachment.bytes,
        kind: "communication-attachment"
      });

      try {
        await prisma.communicationAttachment.create({
          data: {
            communicationId,
            storageBucket: stored.bucket,
            storageKey: stored.key,
            originalName: attachment.fileName,
            mimeType: attachment.mimeType,
            sizeBytes: stored.sizeBytes,
            sha256
          }
        });
      } catch (error) {
        await this.storage
          .deleteObject({ bucket: stored.bucket, key: stored.key })
          .catch(() => undefined);
        if (isUniqueConstraintViolation(error)) {
          continue;
        }
        throw error;
      }
    }
  }
}

async function resolveInboundReplyCase(email: InboundEmail): Promise<{
  caseId: string;
  organizationId: string;
  debtorEmail: string | null;
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
      include: { debtor: true }
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

  const outboundMatches = await prisma.communication.findMany({
    where: {
      direction: "OUTBOUND",
      OR: [
        { messageId: { in: threadIds } },
        { providerId: { in: threadIds } }
      ]
    },
    include: {
      case: {
        include: { debtor: true }
      }
    },
    orderBy: { createdAt: "desc" },
    take: 2
  });

  if (outboundMatches.length !== 1) {
    return null;
  }

  return summarizeMatch(outboundMatches[0].case, "MESSAGE_THREAD");
}

function summarizeMatch(
  collectionCase: {
    id: string;
    organizationId: string;
    debtor: { email: string | null } | null;
  },
  correlation: "SIGNED_REPLY_ADDRESS" | "MESSAGE_THREAD"
) {
  return {
    caseId: collectionCase.id,
    organizationId: collectionCase.organizationId,
    debtorEmail: collectionCase.debtor?.email ?? null,
    correlation
  };
}

function safeEmailRaw(
  email: InboundEmail,
  rejectedAttachments: RejectedReplyAttachment[]
): Prisma.InputJsonObject {
  return {
    provider: email.provider,
    providerId: email.providerId,
    messageId: email.messageId,
    inReplyTo: email.inReplyTo,
    references: email.references,
    autoSubmitted: email.autoSubmitted,
    precedence: email.precedence,
    from: email.from,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    attachments: email.attachments.map((attachment) => ({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.bytes.byteLength
    })),
    rejectedAttachments
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

function isAutomatedEmail(email: InboundEmail): boolean {
  return (
    (email.autoSubmitted !== null &&
      email.autoSubmitted !== "no" &&
      email.autoSubmitted !== "none") ||
    email.precedence === "bulk" ||
    email.precedence === "junk" ||
    email.precedence === "list"
  );
}

function normalizeMessageId(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^<|>$/g, "").toLowerCase();
  return normalized || null;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

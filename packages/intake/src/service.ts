import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createAiProvider } from "@fakturio/ai";
import { prisma } from "@fakturio/db";
import type { InboundEmail, InboundEmailAttachment } from "@fakturio/email";
import {
  CASE_EVENT_TYPES,
  MAX_INVOICE_UPLOAD_BYTES,
  isAcceptedInvoiceMimeType,
  parseIsoDate,
  validateInvoiceForWorkflow
} from "@fakturio/shared";
import { createStorageProvider } from "@fakturio/storage";
import { resolveCustomer, resolveDebtor } from "./counterparty-resolver";
import type {
  CreateFromEmailInput,
  CreateFromUploadInput,
  IntakeActor,
  IntakeCaseResult,
  InvoiceFilePayload,
  InvoiceIntakeDependencies
} from "./types";

export type EmailIntakeResult = {
  cases: IntakeCaseResult[];
  skippedAttachments: Array<{ fileName: string; mimeType: string; reason: string }>;
};

export class InvoiceIntakeService {
  private readonly deps: InvoiceIntakeDependencies;

  constructor(deps: Partial<InvoiceIntakeDependencies> = {}) {
    this.deps = {
      ai: deps.ai ?? createAiProvider(),
      storage: deps.storage ?? createStorageProvider()
    };
  }

  async createFromUpload(input: CreateFromUploadInput): Promise<IntakeCaseResult> {
    assertInvoiceFile(input);

    return this.createCaseFromFile({
      organizationId: input.organizationId,
      file: input,
      sourceType: "UPLOAD",
      actor: { actorType: "USER", actorId: input.userId },
      caseCreatedNote: `Uploaded ${input.fileName}.`
    });
  }

  async createFromEmail(input: CreateFromEmailInput): Promise<EmailIntakeResult> {
    const acceptedAttachments: InboundEmailAttachment[] = [];
    const skippedAttachments: EmailIntakeResult["skippedAttachments"] = [];

    for (const attachment of input.email.attachments) {
      const validation = validateAttachment(attachment);
      if (validation) {
        skippedAttachments.push({
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          reason: validation
        });
      } else {
        acceptedAttachments.push(attachment);
      }
    }

    if (acceptedAttachments.length === 0) {
      const result = await this.createManualReviewEmailCase(input.organizationId, input.email, skippedAttachments);
      return { cases: [result], skippedAttachments };
    }

    const cases: IntakeCaseResult[] = [];
    for (const attachment of acceptedAttachments) {
      cases.push(
        await this.createCaseFromFile({
          organizationId: input.organizationId,
          file: attachment,
          sourceType: "EMAIL",
          actor: { actorType: "EMAIL_PROVIDER" },
          caseCreatedNote: `Inbound email ${input.email.providerId} attachment ${attachment.fileName}.`,
          email: input.email
        })
      );
    }

    return { cases, skippedAttachments };
  }

  private async createCaseFromFile(input: {
    organizationId: string;
    file: InvoiceFilePayload;
    sourceType: "UPLOAD" | "EMAIL";
    actor: IntakeActor;
    caseCreatedNote: string;
    email?: InboundEmail;
  }): Promise<IntakeCaseResult> {
    const collectionCase = await prisma.case.create({
      data: {
        organizationId: input.organizationId,
        sourceType: input.sourceType,
        status: "RECEIVED",
        events: {
          create: {
            actorType: input.actor.actorType,
            actorId: input.actor.actorId,
            type: CASE_EVENT_TYPES.caseCreated,
            note: input.caseCreatedNote
          }
        }
      }
    });

    const communication = input.email
      ? await createInboundCommunication(collectionCase.id, input.email)
      : null;

    const stored = await this.deps.storage.putObject({
      organizationId: input.organizationId,
      caseId: collectionCase.id,
      fileName: input.file.fileName,
      contentType: input.file.mimeType,
      body: input.file.bytes
    });

    await prisma.invoiceDocument.create({
      data: {
        caseId: collectionCase.id,
        communicationId: communication?.id,
        sourceType: input.sourceType,
        storageBucket: stored.bucket,
        storageKey: stored.key,
        originalName: input.file.fileName,
        mimeType: input.file.mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: hashBytes(input.file.bytes)
      }
    });

    try {
      const parsed = await this.deps.ai.extractInvoice({
        fileName: input.file.fileName,
        mimeType: input.file.mimeType,
        bytes: input.file.bytes
      });

      const debtorResolution = await resolveDebtor(input.organizationId, parsed.debtor);
      const customerResolution = await resolveCustomer(input.organizationId, parsed.supplier);

      const validation = validateInvoiceForWorkflow({
        invoiceNumber: parsed.invoiceNumber,
        dueDate: parsed.dueDate,
        amountTotal: parsed.amountTotal,
        debtorName: parsed.debtor.name,
        currency: parsed.currency,
        warnings: parsed.warnings
      });
      const warnings = validation.warningsPatch ?? parsed.warnings;
      const status = parsed.manualReviewRequired || validation.errors.length > 0 ? "MANUAL_REVIEW_REQUIRED" : "PARSED";

      await prisma.case.update({
        where: { id: collectionCase.id },
        data: {
          status,
          customerId: customerResolution?.customer.id,
          debtorId: debtorResolution?.debtor.id,
          invoiceNumber: parsed.invoiceNumber,
          issueDate: parseIsoDate(parsed.issueDate),
          dueDate: parseIsoDate(parsed.dueDate),
          amountTotal: parsed.amountTotal,
          currency: parsed.currency ?? validation.currencyPatch,
          supplierSnapshot: parsed.supplier,
          debtorSnapshot: parsed.debtor,
          paymentSnapshot: parsed.payment,
          subjectNote: parsed.subjectNote,
          aiConfidence: parsed.confidence,
          warnings,
          rawAiResult: toJsonValue(parsed.rawResult),
          events: {
            create: {
              actorType: "AI",
              type: status === "PARSED" ? CASE_EVENT_TYPES.invoiceParsed : CASE_EVENT_TYPES.manualReviewRequired,
              note: status === "PARSED" ? "OpenAI extraction completed." : validation.errors.join(" ") || "Manual review required.",
              payload: {
                customerMatch: customerResolution
                  ? { id: customerResolution.customer.id, method: customerResolution.matchMethod, created: customerResolution.created }
                  : null,
                debtorMatch: debtorResolution
                  ? { id: debtorResolution.debtor.id, method: debtorResolution.matchMethod, created: debtorResolution.created }
                  : null
              }
            }
          }
        }
      });

      return { caseId: collectionCase.id, status, parseError: null };
    } catch (error) {
      await prisma.case.update({
        where: { id: collectionCase.id },
        data: {
          status: "MANUAL_REVIEW_REQUIRED",
          warnings: ["Automatické načítanie zlyhalo. Doplňte údaje manuálne."],
          events: {
            create: {
              actorType: "AI",
              type: CASE_EVENT_TYPES.manualReviewRequired,
              note: error instanceof Error ? error.message : "AI parse failed."
            }
          }
        }
      });

      return {
        caseId: collectionCase.id,
        status: "MANUAL_REVIEW_REQUIRED",
        parseError: error instanceof Error ? error.message : "AI parse failed."
      };
    }
  }

  private async createManualReviewEmailCase(
    organizationId: string,
    email: InboundEmail,
    skippedAttachments: EmailIntakeResult["skippedAttachments"]
  ): Promise<IntakeCaseResult> {
    const collectionCase = await prisma.case.create({
      data: {
        organizationId,
        sourceType: "EMAIL",
        status: "MANUAL_REVIEW_REQUIRED",
        warnings: ["Email neobsahoval podporovanú PDF alebo obrazovú faktúru."],
        events: {
          create: {
            actorType: "EMAIL_PROVIDER",
            type: CASE_EVENT_TYPES.manualReviewRequired,
            note: `Inbound email ${email.providerId} requires manual review.`
          }
        }
      }
    });
    await createInboundCommunication(collectionCase.id, email, { skippedAttachments });

    return {
      caseId: collectionCase.id,
      status: "MANUAL_REVIEW_REQUIRED",
      parseError: "No supported invoice attachment found."
    };
  }
}

export function validateAttachment(file: InvoiceFilePayload): string | null {
  if (!isAcceptedInvoiceMimeType(file.mimeType)) {
    return "Unsupported invoice attachment type.";
  }

  if (file.bytes.byteLength > MAX_INVOICE_UPLOAD_BYTES) {
    return "Invoice attachment exceeds 20 MB limit.";
  }

  return null;
}

export function assertInvoiceFile(file: InvoiceFilePayload): void {
  const error = validateAttachment(file);
  if (error) {
    throw new Error(error);
  }
}

async function createInboundCommunication(caseId: string, email: InboundEmail, extraPayload?: Record<string, unknown>) {
  const rawPayload = {
    ...safeEmailRaw(email),
    ...toJsonObject(extraPayload)
  } satisfies Prisma.InputJsonObject;

  return prisma.communication.create({
    data: {
      caseId,
      direction: "INBOUND",
      channel: "EMAIL",
      status: "RECEIVED",
      provider: email.provider,
      providerId: email.providerId,
      fromAddress: email.from,
      toAddress: email.to.join(", "),
      subject: email.subject,
      textBody: email.textBody,
      htmlBody: email.htmlBody,
      rawPayload,
      receivedAt: new Date()
    }
  });
}

function safeEmailRaw(email: InboundEmail): Prisma.InputJsonObject {
  const raw = toJsonValue(email.raw);
  const payload = {
    provider: email.provider,
    providerId: email.providerId,
    from: email.from,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    attachmentNames: email.attachments.map((attachment) => attachment.fileName)
  } satisfies Prisma.InputJsonObject;

  return raw === undefined ? payload : ({ ...payload, raw } satisfies Prisma.InputJsonObject);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toJsonObject(value: Record<string, unknown> | undefined): Prisma.InputJsonObject {
  if (value === undefined) {
    return {};
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

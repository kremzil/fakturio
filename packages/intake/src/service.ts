import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createAiProvider } from "@fakturio/ai";
import { prisma } from "@fakturio/db";
import {
  buildCustomerInvoiceClarificationRequest,
  buildCustomerMultiAttachmentClarificationRequest,
  createEmailProvider,
  type InboundEmail,
  type InboundEmailAttachment
} from "@fakturio/email";
import {
  CASE_EVENT_TYPES,
  cleanText,
  createCaseClarificationAddress,
  MAX_INVOICE_UPLOAD_BYTES,
  isAcceptedInvoiceMimeType,
  parseIsoDate,
  requireInboundReplyTokenSecret,
  validateInvoiceEmailAttachmentTriage,
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

export type MultiAttachmentClarificationResult = {
  caseIds: string[];
  communicationId: string | null;
  status: string;
  replySent: boolean;
  stillNeedsClarification: boolean;
};

export class InvoiceIntakeService {
  private readonly deps: InvoiceIntakeDependencies;

  constructor(deps: Partial<InvoiceIntakeDependencies> = {}) {
    this.deps = {
      ai: deps.ai ?? createAiProvider(),
      storage: deps.storage ?? createStorageProvider(),
      email: deps.email ?? createEmailProvider()
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

    if (acceptedAttachments.length > 1) {
      return this.createFromMultiAttachmentEmail(input, acceptedAttachments, skippedAttachments);
    }

    const cases: IntakeCaseResult[] = [];
    for (const attachment of acceptedAttachments) {
      const idempotencyKey = inboundInvoiceIdempotencyKey(input.email, attachment);
      const existing = await findExistingInboundCase(idempotencyKey);
      if (existing) {
        cases.push(existing);
        continue;
      }

      cases.push(
        await this.createCaseFromFile({
          organizationId: input.organizationId,
          file: attachment,
          sourceType: "EMAIL",
          actor: { actorType: "EMAIL_PROVIDER" },
          caseCreatedNote: `Inbound email ${input.email.providerId} attachment ${attachment.fileName}.`,
          email: input.email,
          communicationIdempotencyKey: idempotencyKey
        })
      );
    }

    return { cases, skippedAttachments };
  }

  async resolveMultiAttachmentClarification(input: {
    organizationId: string;
    caseId: string;
    email: InboundEmail;
  }): Promise<MultiAttachmentClarificationResult | null> {
    const existingReply = await prisma.communication.findUnique({
      where: {
        idempotencyKey: `customer-multi-attachment-reply:${input.email.provider}:${input.email.providerId}:${input.caseId}`
      },
      include: { case: true }
    });
    if (existingReply) {
      return {
        caseIds: [existingReply.caseId],
        communicationId: existingReply.id,
        status: existingReply.case.status,
        replySent: false,
        stillNeedsClarification: existingReply.case.status === "MANUAL_REVIEW_REQUIRED"
      };
    }

    const pending = await prisma.communication.findFirst({
      where: {
        caseId: input.caseId,
        case: { organizationId: input.organizationId },
        direction: "INBOUND",
        rawPayload: {
          path: ["pendingMultiAttachmentClarification"],
          not: Prisma.JsonNull
        }
      },
      include: { attachments: true, case: true },
      orderBy: { createdAt: "desc" }
    });
    if (!pending || pending.attachments.length < 2) {
      return null;
    }

    const replyCommunication = await createInboundCommunication(
      input.caseId,
      input.email,
      { kind: "customer-multi-attachment-clarification-reply" },
      `customer-multi-attachment-reply:${input.email.provider}:${input.email.providerId}:${input.caseId}`
    );

    const files = await Promise.all(
      pending.attachments.map(async (attachment, index) => {
        const object = await this.deps.storage.getObject({
          bucket: attachment.storageBucket,
          key: attachment.storageKey
        });
        return {
          index,
          fileName: attachment.originalName,
          mimeType: attachment.mimeType,
          sizeBytes: object.sizeBytes ?? attachment.sizeBytes,
          sha256: attachment.sha256,
          bytes: object.body
        };
      })
    );

    const triage = validateInvoiceEmailAttachmentTriage(
      await this.deps.ai.classifyInvoiceEmailAttachments({
        organizationId: input.organizationId,
        subject: input.email.subject,
        messageText: input.email.textBody,
        attachments: files
      }),
      files.length
    );

    if (triage.decision === "NEEDS_CUSTOMER_CLARIFICATION") {
      await this.sendCustomerMultiAttachmentClarificationRequest({
        caseId: input.caseId,
        customerEmail: input.email.from,
        attachmentNames: files.map((file) => file.fileName),
        question: triage.customerQuestion,
        idempotencyKey: `customer-multi-attachment-clarification-followup:${input.email.provider}:${input.email.providerId}:${input.caseId}`
      });
      await prisma.caseEvent.create({
        data: {
          caseId: input.caseId,
          actorType: "AI",
          type: CASE_EVENT_TYPES.manualReviewRequired,
          note: "Customer multi-attachment clarification was still ambiguous.",
          payload: {
            communicationId: replyCommunication.id,
            warnings: triage.warnings
          }
        }
      });
      return {
        caseIds: [input.caseId],
        communicationId: replyCommunication.id,
        status: "MANUAL_REVIEW_REQUIRED",
        replySent: true,
        stillNeedsClarification: true
      };
    }

    const caseIds: string[] = [];
    for (const [groupIndex, group] of triage.groups.entries()) {
      const primary = files[group.primaryInvoiceAttachmentIndex];
      if (!primary) {
        throw new Error("Attachment triage selected a missing primary invoice.");
      }
      const supporting = group.supportingAttachmentIndexes.map((index) => {
        const file = files[index];
        if (!file) {
          throw new Error("Attachment triage selected a missing supporting document.");
        }
        return file;
      });

      if (groupIndex === 0) {
        await this.populateExistingCaseFromFile({
          organizationId: input.organizationId,
          caseId: input.caseId,
          file: primary,
          sourceType: "EMAIL",
          actor: { actorType: "EMAIL_PROVIDER" },
          caseParsedNote: "Multi-attachment clarification selected this document as the primary invoice.",
          communicationId: pending.id
        });
        caseIds.push(input.caseId);
      } else {
        const collectionCase = await prisma.case.create({
          data: {
            organizationId: input.organizationId,
            sourceType: "EMAIL",
            status: "RECEIVED",
            events: {
              create: {
                actorType: "EMAIL_PROVIDER",
                type: CASE_EVENT_TYPES.caseCreated,
                note: `Case created from multi-attachment clarification for ${primary.fileName}.`
              }
            }
          }
        });
        const communication = await cloneInboundCommunicationForSplitCase({
          caseId: collectionCase.id,
          sourceCommunication: pending,
          primaryFileName: primary.fileName
        });
        await this.storeCommunicationAttachments({
          organizationId: input.organizationId,
          caseId: collectionCase.id,
          communicationId: communication.id,
          attachments: supporting
        });
        await this.populateExistingCaseFromFile({
          organizationId: input.organizationId,
          caseId: collectionCase.id,
          file: primary,
          sourceType: "EMAIL",
          actor: { actorType: "EMAIL_PROVIDER" },
          caseParsedNote: "Case created from customer clarification of multiple attachments.",
          communicationId: communication.id
        });
        caseIds.push(collectionCase.id);
      }
    }

    await prisma.caseEvent.create({
      data: {
        caseId: input.caseId,
        actorType: "AI",
        type: CASE_EVENT_TYPES.statusChanged,
        note: `Multi-attachment clarification resolved into ${caseIds.length} case(s).`,
        payload: {
          communicationId: replyCommunication.id,
          caseIds,
          decision: triage.decision,
          confidence: triage.confidence
        }
      }
    });

    return {
      caseIds,
      communicationId: replyCommunication.id,
      status: "PARSED",
      replySent: false,
      stillNeedsClarification: false
    };
  }

  private async createFromMultiAttachmentEmail(
    input: CreateFromEmailInput,
    acceptedAttachments: InboundEmailAttachment[],
    skippedAttachments: EmailIntakeResult["skippedAttachments"]
  ): Promise<EmailIntakeResult> {
    const attachmentRefs = acceptedAttachments.map((attachment, index) => ({
      index,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.bytes.byteLength,
      sha256: hashBytes(attachment.bytes),
      bytes: attachment.bytes
    }));

    const triage = validateInvoiceEmailAttachmentTriage(
      await this.deps.ai.classifyInvoiceEmailAttachments({
        organizationId: input.organizationId,
        subject: input.email.subject,
        messageText: input.email.textBody,
        attachments: attachmentRefs
      }),
      acceptedAttachments.length
    );

    if (triage.decision === "NEEDS_CUSTOMER_CLARIFICATION") {
      const result = await this.createMultiAttachmentManualReviewCase(
        input.organizationId,
        input.email,
        acceptedAttachments,
        skippedAttachments,
        triage
      );
      return { cases: [result], skippedAttachments };
    }

    const cases: IntakeCaseResult[] = [];
    for (const group of triage.groups) {
      const primary = acceptedAttachments[group.primaryInvoiceAttachmentIndex];
      if (!primary) {
        throw new Error("Attachment triage selected a missing primary invoice.");
      }
      const supportingAttachments = group.supportingAttachmentIndexes.map((index) => {
        const attachment = acceptedAttachments[index];
        if (!attachment) {
          throw new Error("Attachment triage selected a missing supporting document.");
        }
        return attachment;
      });
      const idempotencyKey = inboundInvoiceIdempotencyKey(input.email, primary);
      const existing = await findExistingInboundCase(idempotencyKey);
      if (existing) {
        cases.push(existing);
        continue;
      }

      cases.push(
        await this.createCaseFromFile({
          organizationId: input.organizationId,
          file: primary,
          sourceType: "EMAIL",
          actor: { actorType: "EMAIL_PROVIDER" },
          caseCreatedNote: `Inbound email ${input.email.providerId} attachment ${primary.fileName}.`,
          email: input.email,
          communicationIdempotencyKey: idempotencyKey,
          supportingAttachments,
          communicationExtraPayload: {
            triage: {
              decision: triage.decision,
              confidence: triage.confidence,
              reason: group.reason
            },
            supportingAttachmentNames: supportingAttachments.map((attachment) => attachment.fileName),
            skippedAttachments
          }
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
    communicationIdempotencyKey?: string;
    supportingAttachments?: InboundEmailAttachment[];
    communicationExtraPayload?: Record<string, unknown>;
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

    let communication = null;
    if (input.email) {
      try {
        communication = await createInboundCommunication(
          collectionCase.id,
          input.email,
          input.communicationExtraPayload,
          input.communicationIdempotencyKey
        );
      } catch (error) {
        if (!isUniqueConstraintViolation(error) || !input.communicationIdempotencyKey) {
          throw error;
        }

        await prisma.case.delete({ where: { id: collectionCase.id } });
        const existing = await findExistingInboundCase(
          input.communicationIdempotencyKey
        );
        if (existing) {
          return existing;
        }
        throw error;
      }
    }

    let stored: Awaited<ReturnType<InvoiceIntakeDependencies["storage"]["putObject"]>> | null = null;
    try {
      stored = await this.deps.storage.putObject({
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

      if (communication && input.supportingAttachments?.length) {
        await this.storeCommunicationAttachments({
          organizationId: input.organizationId,
          caseId: collectionCase.id,
          communicationId: communication.id,
          attachments: input.supportingAttachments
        });
      }
    } catch (error) {
      if (stored) {
        await this.deps.storage
          .deleteObject({ bucket: stored.bucket, key: stored.key })
          .catch(() => undefined);
      }
      await prisma.case.delete({ where: { id: collectionCase.id } }).catch(() => undefined);
      throw error;
    }

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

      if (input.sourceType === "EMAIL" && input.email && status === "MANUAL_REVIEW_REQUIRED") {
        await this.sendCustomerClarificationRequest({
          caseId: collectionCase.id,
          customerEmail: input.email.from,
          invoiceNumber: parsed.invoiceNumber,
          missingFields: validation.errors,
          warnings,
          idempotencyKey: `customer-clarification-request:${input.email.provider}:${input.email.providerId}:${collectionCase.id}`
        });
      }

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

      if (input.sourceType === "EMAIL" && input.email) {
        await this.sendCustomerClarificationRequest({
          caseId: collectionCase.id,
          customerEmail: input.email.from,
          invoiceNumber: null,
          missingFields: ["údaje potrebné na spracovanie faktúry"],
          warnings: ["Automatické načítanie zlyhalo. Doplňte údaje manuálne."],
          idempotencyKey: `customer-clarification-request:${input.email.provider}:${input.email.providerId}:${collectionCase.id}`
        });
      }

      return {
        caseId: collectionCase.id,
        status: "MANUAL_REVIEW_REQUIRED",
        parseError: error instanceof Error ? error.message : "AI parse failed."
      };
    }
  }

  private async storeCommunicationAttachments(input: {
    organizationId: string;
    caseId: string;
    communicationId: string;
    attachments: InvoiceFilePayload[];
  }): Promise<void> {
    for (const attachment of input.attachments) {
      const stored = await this.deps.storage.putObject({
        organizationId: input.organizationId,
        caseId: input.caseId,
        fileName: attachment.fileName,
        contentType: attachment.mimeType,
        body: attachment.bytes,
        kind: "communication-attachment"
      });
      await prisma.communicationAttachment.create({
        data: {
          communicationId: input.communicationId,
          storageBucket: stored.bucket,
          storageKey: stored.key,
          originalName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: hashBytes(attachment.bytes)
        }
      });
    }
  }

  private async populateExistingCaseFromFile(input: {
    organizationId: string;
    caseId: string;
    file: InvoiceFilePayload;
    sourceType: "UPLOAD" | "EMAIL";
    actor: IntakeActor;
    caseParsedNote: string;
    communicationId: string | null;
  }): Promise<IntakeCaseResult> {
    const stored = await this.deps.storage.putObject({
      organizationId: input.organizationId,
      caseId: input.caseId,
      fileName: input.file.fileName,
      contentType: input.file.mimeType,
      body: input.file.bytes
    });

    await prisma.invoiceDocument.create({
      data: {
        caseId: input.caseId,
        communicationId: input.communicationId,
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
      const status =
        parsed.manualReviewRequired || validation.errors.length > 0
          ? "MANUAL_REVIEW_REQUIRED"
          : "PARSED";

      await prisma.case.update({
        where: { id: input.caseId },
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
              type:
                status === "PARSED"
                  ? CASE_EVENT_TYPES.invoiceParsed
                  : CASE_EVENT_TYPES.manualReviewRequired,
              note:
                status === "PARSED"
                  ? input.caseParsedNote
                  : validation.errors.join(" ") || "Manual review required.",
              payload: {
                customerMatch: customerResolution
                  ? {
                      id: customerResolution.customer.id,
                      method: customerResolution.matchMethod,
                      created: customerResolution.created
                    }
                  : null,
                debtorMatch: debtorResolution
                  ? {
                      id: debtorResolution.debtor.id,
                      method: debtorResolution.matchMethod,
                      created: debtorResolution.created
                    }
                  : null
              }
            }
          }
        }
      });

      return { caseId: input.caseId, status, parseError: null };
    } catch (error) {
      await prisma.case.update({
        where: { id: input.caseId },
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
        caseId: input.caseId,
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
    const idempotencyKey = `inbound-invoice:${email.provider}:${email.providerId}:manual-review`;
    const existing = await findExistingInboundCase(idempotencyKey);
    if (existing) {
      return existing;
    }

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
    try {
      await createInboundCommunication(
        collectionCase.id,
        email,
        { skippedAttachments },
        idempotencyKey
      );
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      await prisma.case.delete({ where: { id: collectionCase.id } });
      const raced = await findExistingInboundCase(idempotencyKey);
      if (raced) {
        return raced;
      }
      throw error;
    }

    return {
      caseId: collectionCase.id,
      status: "MANUAL_REVIEW_REQUIRED",
      parseError: "No supported invoice attachment found."
    };
  }

  private async createMultiAttachmentManualReviewCase(
    organizationId: string,
    email: InboundEmail,
    acceptedAttachments: InboundEmailAttachment[],
    skippedAttachments: EmailIntakeResult["skippedAttachments"],
    triage: {
      confidence: number;
      customerQuestion: string | null;
      warnings: string[];
    }
  ): Promise<IntakeCaseResult> {
    const idempotencyKey = `inbound-invoice:${email.provider}:${email.providerId}:multi-attachment-review`;
    const existing = await findExistingInboundCase(idempotencyKey);
    if (existing) {
      return existing;
    }

    const collectionCase = await prisma.case.create({
      data: {
        organizationId,
        sourceType: "EMAIL",
        status: "MANUAL_REVIEW_REQUIRED",
        warnings: ["Email obsahuje viac dokumentov a vyžaduje potvrdenie zákazníka."],
        events: {
          create: {
            actorType: "EMAIL_PROVIDER",
            type: CASE_EVENT_TYPES.manualReviewRequired,
            note: `Inbound email ${email.providerId} contains multiple invoice-like documents.`
          }
        }
      }
    });

    try {
      const communication = await createInboundCommunication(
        collectionCase.id,
        email,
        {
          skippedAttachments,
          pendingMultiAttachmentClarification: {
            acceptedAttachmentNames: acceptedAttachments.map((attachment) => attachment.fileName),
            confidence: triage.confidence,
            warnings: triage.warnings
          }
        },
        idempotencyKey
      );
      await this.storeCommunicationAttachments({
        organizationId,
        caseId: collectionCase.id,
        communicationId: communication.id,
        attachments: acceptedAttachments
      });
      await this.sendCustomerMultiAttachmentClarificationRequest({
        caseId: collectionCase.id,
        customerEmail: email.from,
        attachmentNames: acceptedAttachments.map((attachment) => attachment.fileName),
        question: triage.customerQuestion,
        idempotencyKey: `customer-multi-attachment-clarification:${email.provider}:${email.providerId}:${collectionCase.id}`
      });
    } catch (error) {
      await prisma.case.delete({ where: { id: collectionCase.id } }).catch(() => undefined);
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      const raced = await findExistingInboundCase(idempotencyKey);
      if (raced) {
        return raced;
      }
      throw error;
    }

    return {
      caseId: collectionCase.id,
      status: "MANUAL_REVIEW_REQUIRED",
      parseError: "Multiple invoice-like attachments require customer clarification."
    };
  }

  private async sendCustomerClarificationRequest(input: {
    caseId: string;
    customerEmail: string | null;
    invoiceNumber: string | null;
    missingFields: string[];
    warnings: string[];
    idempotencyKey: string;
  }): Promise<void> {
    const to = cleanText(input.customerEmail);
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

    const template = buildCustomerInvoiceClarificationRequest({
      invoiceNumber: input.invoiceNumber,
      missingFields: input.missingFields,
      warnings: input.warnings
    });
    const replyTo = createCaseClarificationAddress(
      { caseId: input.caseId, domain: inboundReplyDomain() },
      requireInboundReplyTokenSecret()
    );
    const from = process.env.SES_FROM_EMAIL || "system@example.com";

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
          subject: template.subject,
          textBody: template.textBody,
          htmlBody: template.htmlBody,
          rawPayload: {
            kind: "customer-invoice-clarification-request",
            replyTo,
            missingFields: input.missingFields
          }
        },
        select: { id: true, status: true }
      }));

    const sent = await this.deps.email.sendEmail({
      from,
      to: [to],
      replyTo: [replyTo],
      subject: template.subject,
      textBody: template.textBody,
      htmlBody: template.htmlBody,
      metadata: {
        caseId: input.caseId,
        kind: "customer-clarification"
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
          note: `Customer clarification request sent to ${to}.`,
          payload: {
            communicationId: communication.id,
            missingFields: input.missingFields
          }
        }
      })
    ]);
  }

  private async sendCustomerMultiAttachmentClarificationRequest(input: {
    caseId: string;
    customerEmail: string | null;
    attachmentNames: string[];
    question: string | null;
    idempotencyKey: string;
  }): Promise<void> {
    const to = cleanText(input.customerEmail);
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

    const template = buildCustomerMultiAttachmentClarificationRequest({
      attachmentNames: input.attachmentNames,
      question: input.question
    });
    const replyTo = createCaseClarificationAddress(
      { caseId: input.caseId, domain: inboundReplyDomain() },
      requireInboundReplyTokenSecret()
    );
    const from = process.env.SES_FROM_EMAIL || "system@example.com";
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
          subject: template.subject,
          textBody: template.textBody,
          htmlBody: template.htmlBody,
          rawPayload: {
            kind: "customer-multi-attachment-clarification-request",
            replyTo,
            attachmentNames: input.attachmentNames
          }
        },
        select: { id: true, status: true }
      }));

    const sent = await this.deps.email.sendEmail({
      from,
      to: [to],
      replyTo: [replyTo],
      subject: template.subject,
      textBody: template.textBody,
      htmlBody: template.htmlBody,
      metadata: {
        caseId: input.caseId,
        kind: "customer-multi-attachment-clarification"
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
          note: `Customer multi-attachment clarification request sent to ${to}.`,
          payload: {
            communicationId: communication.id,
            attachmentNames: input.attachmentNames
          }
        }
      })
    ]);
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

async function createInboundCommunication(
  caseId: string,
  email: InboundEmail,
  extraPayload?: Record<string, unknown>,
  idempotencyKey?: string
) {
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
      rawPayload,
      receivedAt: new Date()
    }
  });
}

async function cloneInboundCommunicationForSplitCase(input: {
  caseId: string;
  sourceCommunication: {
    provider: string | null;
    providerId: string | null;
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    fromAddress: string | null;
    toAddress: string | null;
    subject: string | null;
    textBody: string | null;
    htmlBody: string | null;
    rawPayload: Prisma.JsonValue | null;
  };
  primaryFileName: string;
}) {
  const idempotencyKey = [
    "inbound-invoice-split",
    input.sourceCommunication.provider ?? "unknown",
    input.sourceCommunication.providerId ?? input.sourceCommunication.messageId ?? input.caseId,
    input.caseId
  ].join(":");

  return prisma.communication.create({
    data: {
      caseId: input.caseId,
      direction: "INBOUND",
      channel: "EMAIL",
      status: "RECEIVED",
      idempotencyKey,
      provider: input.sourceCommunication.provider,
      providerId: input.sourceCommunication.providerId,
      messageId: input.sourceCommunication.messageId,
      inReplyTo: input.sourceCommunication.inReplyTo,
      references: input.sourceCommunication.references,
      fromAddress: input.sourceCommunication.fromAddress,
      toAddress: input.sourceCommunication.toAddress,
      subject: input.sourceCommunication.subject,
      textBody: input.sourceCommunication.textBody,
      htmlBody: input.sourceCommunication.htmlBody,
      rawPayload: {
        ...jsonRecord(input.sourceCommunication.rawPayload),
        splitFromCase: true,
        primaryFileName: input.primaryFileName
      },
      receivedAt: new Date()
    }
  });
}

function safeEmailRaw(email: InboundEmail): Prisma.InputJsonObject {
  const raw = toJsonValue(email.raw);
  const payload = {
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
  } satisfies Prisma.InputJsonObject;

  return raw === undefined ? payload : ({ ...payload, raw } satisfies Prisma.InputJsonObject);
}

async function findExistingInboundCase(
  idempotencyKey: string
): Promise<IntakeCaseResult | null> {
  const communication = await prisma.communication.findUnique({
    where: { idempotencyKey },
    include: { case: true }
  });
  if (!communication) {
    return null;
  }
  return {
    caseId: communication.caseId,
    status: communication.case.status,
    parseError:
      communication.case.status === "MANUAL_REVIEW_REQUIRED"
        ? "Previously received email requires manual review."
        : null
  };
}

function inboundInvoiceIdempotencyKey(
  email: InboundEmail,
  attachment: InboundEmailAttachment
): string {
  return `inbound-invoice:${email.provider}:${email.providerId}:${hashBytes(attachment.bytes)}`;
}

function normalizeMessageId(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^<|>$/g, "").toLowerCase();
  return normalized || null;
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

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
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

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

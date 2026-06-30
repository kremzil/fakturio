import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createAiProvider } from "@fakturio/ai";
import { prisma } from "@fakturio/db";
import {
  buildClarificationRequest,
  buildCustomerExceptionNotice,
  buildDisputeAcknowledgement,
  buildExistingDeadlineReply,
  buildFirstReminderEmail,
  buildInstallmentActivated,
  buildInstallmentBrokenNotice,
  buildInstallmentProposal,
  buildNeutralPaymentReply,
  buildPaymentClaimAcknowledgement,
  buildSecondReminder,
  createEmailProvider,
  isPermanentEmailProviderError,
  type CollectionTemplate
} from "@fakturio/email";
import {
  CASE_EVENT_TYPES,
  assertCaseTransition,
  calculateInstallmentSchedule,
  createCaseClarificationAddress,
  createCaseReplyAddress,
  createPaymentCheckToken,
  debtorReplyClassificationSchema,
  decideDebtorReply,
  PAYMENT_CHECK_TOKEN_DEFAULT_TTL_MS,
  requireInboundReplyTokenSecret,
  requirePaymentCheckTokenSecret,
  type CaseStatus,
  type DebtorReplyClassification
} from "@fakturio/shared";
import {
  FIRST_REMINDER_PAYMENT_TERM_DAYS,
  PAYMENT_CHECK_SEND_LEASE_MS,
  type CaseSnapshot,
  type CaseWorkflowActivities,
  type PaymentCheckReason
} from "@fakturio/workflows";

export const activities: CaseWorkflowActivities = {
  async loadCaseSnapshot(input): Promise<CaseSnapshot> {
    const collectionCase = await prisma.case.findUniqueOrThrow({
      where: { id: input.caseId },
      include: {
        debtor: true,
        organization: true,
        installmentPlans: {
          where: { status: "ACTIVE" },
          orderBy: { createdAt: "desc" },
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
    assertCaseOrganization(
      collectionCase.id,
      collectionCase.organizationId,
      input.organizationId
    );

    return {
      id: collectionCase.id,
      status: collectionCase.status,
      dueDate: isoDate(collectionCase.dueDate),
      invoiceNumber: collectionCase.invoiceNumber,
      amountTotal: decimalNumber(collectionCase.amountTotal),
      currency: collectionCase.currency,
      debtorName: collectionCase.debtor?.name ?? null,
      debtorEmail: collectionCase.debtor?.email ?? null,
      customerEmail: await getCustomerCheckRecipient(
        collectionCase.organizationId,
        collectionCase.confirmedByUserId
      ),
      organizationName: collectionCase.organization.name,
      nextActionAt: collectionCase.nextActionAt?.toISOString() ?? null,
      automationPaused: Boolean(collectionCase.automationPausedAt),
      nextInstallmentPaymentId:
        collectionCase.installmentPlans[0]?.payments[0]?.id ?? null
    };
  },

  async recordWorkflowEvent(input) {
    await assertCaseInOrganization(input.caseId, input.organizationId);
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
    const collectionCase = await loadCaseForCollection(
      input.caseId,
      input.organizationId
    );
    const recipient = collectionCase.debtor?.email?.trim();
    if (!recipient) {
      await pauseForMissingContact(
        collectionCase.id,
        collectionCase.organizationId,
        "MISSING_DEBTOR_EMAIL",
        `Debtor reminder ${input.reminderLevel} was not sent because the debtor has no email address.`
      );
      return "SKIPPED_MISSING_RECIPIENT";
    }
    requireInvoiceEmailData(collectionCase);

    const creditorName = resolveCreditorName(collectionCase);
    const fromAddress = outboundFromAddress();
    const replyTo = caseReplyAddress(collectionCase.id);
    let template: CollectionTemplate;
    let expectedStatuses: Array<typeof collectionCase.status>;
    let nextStatus: typeof collectionCase.status;
    let nextActionAt: Date | null;

    if (input.reminderLevel === 1) {
      if (collectionCase.status !== "OVERDUE") {
        return "SKIPPED_CASE_STATE";
      }
      const paymentTermDays = firstReminderPaymentTermDays();
      nextActionAt = addUtcDays(startOfUtcDay(new Date()), paymentTermDays);
      const supplier = jsonRecord(collectionCase.supplierSnapshot);
      const payment = jsonRecord(collectionCase.paymentSnapshot);
      template = buildFirstReminderEmail({
        debtorName: collectionCase.debtor?.name ?? recipient,
        creditorName,
        creditorAddress:
          collectionCase.customer?.address ?? stringValue(supplier.address),
        creditorIco:
          collectionCase.customer?.ico ?? stringValue(supplier.ico),
        invoiceNumber: collectionCase.invoiceNumber!,
        amountTotal: Number(collectionCase.amountTotal),
        currency: collectionCase.currency ?? "EUR",
        originalDueDate: isoDate(collectionCase.dueDate)!,
        requestedPaymentDate: isoDate(nextActionAt)!,
        iban: stringValue(payment.iban),
        variableSymbol: stringValue(payment.variableSymbol),
        subjectNote: collectionCase.subjectNote
      });
      expectedStatuses = ["OVERDUE"];
      nextStatus = "EMAIL_REMINDER_1_SENT";
    } else if (input.reminderLevel === 2) {
      if (
        collectionCase.status !== "EMAIL_REMINDER_1_SENT" &&
        collectionCase.status !== "PAYMENT_PROMISED"
      ) {
        return "SKIPPED_CASE_STATE";
      }
      template = buildSecondReminder({
        invoiceNumber: collectionCase.invoiceNumber!,
        amountTotal: Number(collectionCase.amountTotal),
        currency: collectionCase.currency ?? "EUR",
        creditorName
      });
      expectedStatuses = ["EMAIL_REMINDER_1_SENT", "PAYMENT_PROMISED"];
      nextStatus = "EMAIL_REMINDER_2_SENT";
      nextActionAt = null;
    } else {
      throw new Error(`Reminder level ${input.reminderLevel} is not implemented.`);
    }
    for (const status of expectedStatuses) {
      assertCaseTransition(status as CaseStatus, nextStatus as CaseStatus);
    }

    const result = await sendTrackedEmail({
      caseId: collectionCase.id,
      idempotencyKey: `debtor-reminder:${input.reminderLevel}:${collectionCase.id}`,
      fromAddress,
      toAddress: recipient,
      replyTo,
      template,
      metadata: {
        caseId: collectionCase.id,
        organizationId: collectionCase.organizationId,
        kind: `debtor-reminder-${input.reminderLevel}`
      },
      rawPayload: {
        kind: "debtor-reminder",
        reminderLevel: input.reminderLevel,
        replyTo,
        nextActionAt: nextActionAt?.toISOString() ?? null
      },
      onConfirmed: async (tx, communicationId, provider) => {
        const changed = await tx.case.updateMany({
          where: {
            id: collectionCase.id,
            organizationId: collectionCase.organizationId,
            status: { in: expectedStatuses }
          },
          data: {
            status: nextStatus,
            nextActionAt,
            automationPausedAt: null,
            automationPauseReason: null
          }
        });
        await tx.caseEvent.create({
          data: {
            caseId: collectionCase.id,
            actorType: "WORKFLOW",
            type: CASE_EVENT_TYPES.emailSent,
            note: `Debtor reminder ${input.reminderLevel} sent to ${recipient}.`,
            payload: {
              communicationId,
              provider,
              statusAdvanced: changed.count === 1,
              nextActionAt: nextActionAt?.toISOString() ?? null
            }
          }
        });
      }
    });

    return result;
  },

  async sendPaymentCheckEmail(input) {
    const collectionCase = await loadCaseForCollection(
      input.caseId,
      input.organizationId
    );
    const recipient = await getCustomerCheckRecipient(
      collectionCase.organizationId,
      collectionCase.confirmedByUserId
    );
    if (!recipient) {
      await pauseForMissingContact(
        collectionCase.id,
        collectionCase.organizationId,
        "MISSING_CUSTOMER_EMAIL",
        "Payment check was not sent because no customer recipient email is configured."
      );
      return null;
    }
    const reason = input.reason ?? "DUE_DATE";
    const sourceKey =
      input.sourceKey ??
      `due-date:${collectionCase.id}:${isoDate(collectionCase.dueDate) ?? "unknown"}`;

    const installmentPayment = input.installmentPaymentId
      ? await prisma.installmentPayment.findFirst({
          where: {
            id: input.installmentPaymentId,
            plan: {
              caseId: collectionCase.id,
              case: { organizationId: collectionCase.organizationId }
            }
          },
          include: { plan: true }
        })
      : null;
    if (input.installmentPaymentId && !installmentPayment) {
      throw new Error("Installment payment does not belong to this case.");
    }

    const paymentCheck = await findOrCreatePaymentCheck({
      caseId: collectionCase.id,
      sourceKey,
      reason,
      installmentPaymentId: installmentPayment?.id ?? null,
      expectedAmount:
        installmentPayment?.amount ?? collectionCase.amountTotal ?? null,
      currency:
        installmentPayment?.plan.currency ?? collectionCase.currency ?? "EUR"
    });

    if (
      paymentCheck.status === "RESOLVED_PAID" ||
      paymentCheck.status === "RESOLVED_NOT_PAID"
    ) {
      return { paymentCheckId: paymentCheck.id };
    }

    const secret = requirePaymentCheckTokenSecret();
    const paidToken = createPaymentCheckToken(
      {
        paymentCheckId: paymentCheck.id,
        caseId: collectionCase.id,
        organizationId: collectionCase.organizationId,
        action: "PAID",
        expiresAt: paymentCheck.expiresAt.getTime()
      },
      secret
    );
    const notPaidToken = createPaymentCheckToken(
      {
        paymentCheckId: paymentCheck.id,
        caseId: collectionCase.id,
        organizationId: collectionCase.organizationId,
        action: "NOT_PAID",
        expiresAt: paymentCheck.expiresAt.getTime()
      },
      secret
    );
    const publicUrl =
      process.env.NEXTAUTH_URL ||
      process.env.APP_URL ||
      "http://localhost:3000";
    const paidUrl = `${publicUrl}/api/cases/${collectionCase.id}/payment-check/paid?token=${paidToken}`;
    const notPaidUrl = `${publicUrl}/api/cases/${collectionCase.id}/payment-check/not-paid?token=${notPaidToken}`;
    const template = buildPaymentCheckTemplate({
      invoiceNumber: collectionCase.invoiceNumber ?? collectionCase.id,
      debtorName: collectionCase.debtor?.name ?? "nezistený odberateľ",
      amount: decimalNumber(paymentCheck.expectedAmount),
      currency: paymentCheck.currency ?? collectionCase.currency ?? "EUR",
      dueDate:
        isoDate(installmentPayment?.dueDate) ??
        isoDate(collectionCase.dueDate) ??
        "nezistený dátum",
      installmentSequence: installmentPayment?.sequence ?? null,
      paidUrl,
      notPaidUrl
    });

    try {
      await sendTrackedEmail({
        caseId: collectionCase.id,
        idempotencyKey: `payment-check:${paymentCheck.id}`,
        fromAddress: outboundFromAddress(),
        toAddress: recipient,
        template,
        metadata: {
          caseId: collectionCase.id,
          organizationId: collectionCase.organizationId,
          kind: "payment-check",
          paymentCheckId: paymentCheck.id
        },
        rawPayload: {
          kind: "payment-check",
          paymentCheckId: paymentCheck.id,
          reason: paymentCheck.reason,
          paidUrl,
          notPaidUrl
        },
        onConfirmed: async (tx, communicationId, provider) => {
          await tx.paymentCheck.updateMany({
            where: {
              id: paymentCheck.id,
              caseId: collectionCase.id,
              status: { in: ["PENDING", "SENT"] }
            },
            data: { status: "SENT", communicationId }
          });
          await tx.case.updateMany({
            where: {
              id: collectionCase.id,
              organizationId: collectionCase.organizationId
            },
            data: { nextActionAt: null }
          });
          await tx.caseEvent.create({
            data: {
              caseId: collectionCase.id,
              actorType: "WORKFLOW",
              type: CASE_EVENT_TYPES.paymentCheckSent,
              note: `Payment check ${paymentCheck.sequence} sent to ${recipient}.`,
              payload: {
                paymentCheckId: paymentCheck.id,
                reason: paymentCheck.reason,
                communicationId,
                provider
              }
            }
          });
        }
      });
    } catch (error) {
      if (!isPermanentEmailProviderError(error)) {
        throw error;
      }
      await pauseForMissingContact(
        collectionCase.id,
        collectionCase.organizationId,
        "CUSTOMER_EMAIL_REJECTED",
        `Payment check was not sent because the customer email provider rejected ${recipient}.`
      );
      return null;
    }

    return { paymentCheckId: paymentCheck.id };
  },

  async processDebtorReply(input) {
    const communication = await prisma.communication.findUniqueOrThrow({
      where: { id: input.communicationId },
      include: {
        case: {
          include: {
            debtor: true,
            customer: true,
            organization: true,
            installmentPlans: {
              where: { status: "PROPOSED" },
              orderBy: { createdAt: "desc" },
              take: 1,
              include: { payments: { orderBy: { sequence: "asc" } } }
            }
          }
        }
      }
    });
    assertCaseOrganization(
      communication.caseId,
      communication.case.organizationId,
      input.organizationId
    );
    if (communication.caseId !== input.caseId) {
      throw new Error("Inbound communication belongs to another case.");
    }
    if (await clarificationWasAlreadySent(communication.id)) {
      await ensureClarificationRecorded(
        communication.caseId,
        communication.id,
        "Clarification request already delivered."
      );
      return {
        kind: "CLARIFICATION_REQUESTED",
        communicationId: communication.id
      };
    }

    const classification = await classifyInboundCommunication(communication);
    const senderMatchesDebtor =
      Boolean(communication.case.debtor?.email) &&
      communication.case.debtor!.email!.toLowerCase() ===
        communication.fromAddress?.toLowerCase();
    const raw = jsonRecord(communication.rawPayload);
    const automated = isAutomatedRawEmail(raw);
    const proposedPlan = communication.case.installmentPlans[0] ?? null;
    const decision = decideDebtorReply({
      classification,
      senderMatchesDebtor,
      automated,
      clarificationCount: communication.case.clarificationCount,
      promiseExtensionUsed: communication.case.promiseExtensionUsed,
      receivedAt: communication.receivedAt ?? communication.createdAt,
      hasProposedInstallmentPlan: Boolean(proposedPlan),
      expectedAmount: decimalNumber(communication.case.amountTotal)
    });

    const result = await applyReplyDecision({
      communication,
      classification,
      decision,
      proposedPlan
    });
    return { ...result, communicationId: communication.id };
  },

  async loadPaymentCheckResult(input) {
    const paymentCheck = await prisma.paymentCheck.findFirst({
      where: {
        id: input.paymentCheckId,
        caseId: input.caseId,
        case: { organizationId: input.organizationId }
      }
    });
    if (!paymentCheck) {
      throw new Error("Payment check was not found in the workflow organization.");
    }
    if (
      paymentCheck.status !== "RESOLVED_PAID" &&
      paymentCheck.status !== "RESOLVED_NOT_PAID"
    ) {
      throw new Error(`Payment check ${paymentCheck.id} is not resolved.`);
    }
    return {
      id: paymentCheck.id,
      reason: paymentCheck.reason,
      action:
        paymentCheck.status === "RESOLVED_PAID" ? "PAID" : "NOT_PAID",
      installmentPaymentId: paymentCheck.installmentPaymentId
    };
  },

  async sendInstallmentBrokenEmail(input) {
    const paymentCheck = await prisma.paymentCheck.findFirstOrThrow({
      where: {
        id: input.paymentCheckId,
        caseId: input.caseId,
        case: { organizationId: input.organizationId }
      },
      include: {
        installmentPayment: {
          include: {
            plan: {
              include: {
                payments: true,
                case: {
                  include: { debtor: true }
                }
              }
            }
          }
        }
      }
    });
    const installment = paymentCheck.installmentPayment;
    if (!installment) {
      throw new Error("Broken installment check has no installment payment.");
    }
    const collectionCase = installment.plan.case;
    const recipient = collectionCase.debtor?.email?.trim();
    const remainingAmount = installment.plan.payments
      .filter((payment) => payment.status !== "PAID")
      .reduce((sum, payment) => sum + Number(payment.amount), 0);

    if (recipient) {
      await sendTrackedEmail({
        caseId: collectionCase.id,
        idempotencyKey: `installment-broken:${installment.id}`,
        fromAddress: outboundFromAddress(),
        toAddress: recipient,
        replyTo: caseReplyAddress(collectionCase.id),
        template: buildInstallmentBrokenNotice({
          invoiceNumber:
            collectionCase.invoiceNumber ?? collectionCase.id,
          missedSequence: installment.sequence,
          missedAmount: Number(installment.amount),
          currency: installment.plan.currency,
          remainingAmount
        }),
        metadata: {
          caseId: collectionCase.id,
          organizationId: input.organizationId,
          kind: "installment-broken"
        },
        rawPayload: {
          kind: "installment-broken",
          installmentPaymentId: installment.id
        }
      });
    }

    await sendCustomerNotice(
      collectionCase.id,
      input.organizationId,
      `Splátkový kalendár bol porušený`,
      `Dlžník neuhradil ${installment.sequence}. splátku. Je potrebný telefonický kontakt.`,
      `installment-broken-customer:${installment.id}`
    );
    const callEvent = await prisma.caseEvent.findFirst({
      where: {
        caseId: collectionCase.id,
        type: CASE_EVENT_TYPES.callRequired,
        payload: { path: ["installmentPaymentId"], equals: installment.id }
      },
      select: { id: true }
    });
    if (!callEvent) {
      await prisma.caseEvent.create({
        data: {
          caseId: collectionCase.id,
          actorType: "WORKFLOW",
          type: CASE_EVENT_TYPES.callRequired,
          note: "Installment plan was broken; debtor call is required.",
          payload: { installmentPaymentId: installment.id }
        }
      });
    }
  },

  async markCaseOverdue(input) {
    const changed = await prisma.case.updateMany({
      where: { id: input.caseId, organizationId: input.organizationId },
      data: { status: "OVERDUE" }
    });
    if (changed.count === 0) {
      throw new Error(
        `Case ${input.caseId} was not found in organization ${input.organizationId}.`
      );
    }
  }
};

type CollectionCase = Awaited<ReturnType<typeof loadCaseForCollection>>;
type ProposedPlan = CollectionCase["installmentPlans"][number] | null;

async function applyReplyDecision(input: {
  communication: Awaited<ReturnType<typeof loadReplyCommunication>>;
  classification: DebtorReplyClassification;
  decision: ReturnType<typeof decideDebtorReply>;
  proposedPlan: ProposedPlan;
}): Promise<{
  kind:
    | "IGNORED"
    | "CHECK_PAYMENT_NOW"
    | "DEADLINE_UNCHANGED"
    | "PROMISE_ACCEPTED"
    | "INSTALLMENT_PROPOSED"
    | "INSTALLMENT_ACTIVATED"
    | "INSTALLMENT_REJECTED"
    | "PAUSED"
    | "CLARIFICATION_REQUESTED";
}> {
  const { communication, classification, decision } = input;
  const collectionCase = communication.case;
  const invoiceNumber = collectionCase.invoiceNumber ?? collectionCase.id;

  if (decision.kind === "IGNORE") {
    await recordReplyAction(
      collectionCase.id,
      communication.id,
      decision.kind,
      decision.reason
    );
    return { kind: "IGNORED" };
  }

  if (decision.kind === "CHECK_PAYMENT_NOW") {
    await sendDebtorTemplate(
      collectionCase,
      communication,
      buildPaymentClaimAcknowledgement({ invoiceNumber }),
      "payment-claim-ack"
    );
    await prisma.case.updateMany({
      where: {
        id: collectionCase.id,
        organizationId: collectionCase.organizationId
      },
      data: { nextActionAt: null }
    });
    await recordReplyAction(
      collectionCase.id,
      communication.id,
      decision.kind,
      classification.summary
    );
    return { kind: "CHECK_PAYMENT_NOW" };
  }

  if (decision.kind === "KEEP_EXISTING_DEADLINE") {
    const paymentDate = isoDate(collectionCase.nextActionAt);
    if (paymentDate) {
      await sendDebtorTemplate(
        collectionCase,
        communication,
        buildExistingDeadlineReply({ invoiceNumber, paymentDate }),
        "existing-deadline"
      );
    }
    await recordReplyAction(
      collectionCase.id,
      communication.id,
      decision.kind,
      classification.summary
    );
    return { kind: "DEADLINE_UNCHANGED" };
  }

  if (decision.kind === "ACCEPT_PROMISE") {
    assertCaseTransition(
      collectionCase.status as CaseStatus,
      "PAYMENT_PROMISED"
    );
    await prisma.$transaction(async (tx) => {
      const existing = await tx.paymentPromise.findFirst({
        where: { communicationId: communication.id }
      });
      if (!existing) {
        await tx.paymentPromise.create({
          data: {
            caseId: collectionCase.id,
            communicationId: communication.id,
            promisedDate: decision.paymentDate,
            amount: collectionCase.amountTotal,
            currency: collectionCase.currency,
            note: classification.summary
          }
        });
      }
      await tx.case.update({
        where: { id: collectionCase.id },
        data: {
          status: "PAYMENT_PROMISED",
          nextActionAt: decision.paymentDate,
          promiseExtensionUsed: true,
          automationPausedAt: null,
          automationPauseReason: null
        }
      });
      await tx.caseEvent.create({
        data: {
          caseId: collectionCase.id,
          actorType: "WORKFLOW",
          type: CASE_EVENT_TYPES.paymentPromiseCreated,
          note: `Payment promise accepted until ${isoDate(decision.paymentDate)}.`,
          payload: {
            communicationId: communication.id,
            promisedDate: decision.paymentDate.toISOString()
          }
        }
      });
    });
    await sendDebtorTemplate(
      collectionCase,
      communication,
      buildNeutralPaymentReply({
        invoiceNumber,
        paymentDate: isoDate(decision.paymentDate)!
      }),
      "promise-accepted"
    );
    return { kind: "PROMISE_ACCEPTED" };
  }

  if (decision.kind === "PROPOSE_INSTALLMENT") {
    const plan = await createInstallmentProposal(collectionCase, communication);
    await sendDebtorTemplate(
      collectionCase,
      communication,
      buildInstallmentProposal({
        invoiceNumber,
        currency: plan.currency,
        payments: plan.payments.map(installmentTemplateRow)
      }),
      "installment-proposal"
    );
    return { kind: "INSTALLMENT_PROPOSED" };
  }

  if (decision.kind === "ACTIVATE_INSTALLMENT") {
    const plan = input.proposedPlan;
    if (!plan) {
      throw new Error("No proposed installment plan exists.");
    }
    assertCaseTransition(
      collectionCase.status as CaseStatus,
      "INSTALLMENT_ACTIVE"
    );
    const acceptedAt = new Date();
    const activatedPayments = calculateInstallmentSchedule(
      Number(plan.totalAmount),
      acceptedAt
    );
    await prisma.$transaction(async (tx) => {
      const activated = await tx.installmentPlan.updateMany({
        where: { id: plan.id, caseId: collectionCase.id, status: "PROPOSED" },
        data: { status: "ACTIVE", acceptedAt }
      });
      if (activated.count !== 1) {
        throw new Error(`Installment plan ${plan.id} is no longer proposed.`);
      }
      for (const payment of activatedPayments) {
        await tx.installmentPayment.update({
          where: {
            planId_sequence: {
              planId: plan.id,
              sequence: payment.sequence
            }
          },
          data: { dueDate: payment.dueDate }
        });
      }
      const changed = await tx.case.updateMany({
        where: {
          id: collectionCase.id,
          organizationId: collectionCase.organizationId,
          status: collectionCase.status
        },
        data: {
          status: "INSTALLMENT_ACTIVE",
          nextActionAt: activatedPayments[0].dueDate,
          automationPausedAt: null,
          automationPauseReason: null,
          clarificationCount: 0
        }
      });
      if (changed.count !== 1) {
        throw new Error(`Case ${collectionCase.id} changed during installment activation.`);
      }
      await tx.caseEvent.create({
        data: {
          caseId: collectionCase.id,
          actorType: "WORKFLOW",
          type: CASE_EVENT_TYPES.installmentActivated,
          note: "Debtor explicitly accepted the standard installment plan.",
          payload: {
            communicationId: communication.id,
            planId: plan.id,
            acceptedAt: acceptedAt.toISOString(),
            payments: activatedPayments.map((payment) => ({
              sequence: payment.sequence,
              amount: payment.amount,
              dueDate: payment.dueDate.toISOString()
            }))
          }
        }
      });
    });
    await sendDebtorTemplate(
      collectionCase,
      communication,
      buildInstallmentActivated({
        invoiceNumber,
        currency: plan.currency,
        payments: activatedPayments.map(installmentTemplateRow)
      }),
      "installment-activated"
    );
    await sendCustomerNotice(
      collectionCase.id,
      collectionCase.organizationId,
      "Dlžník prijal splátkový kalendár",
      `Splátkový kalendár k faktúre ${invoiceNumber} bol aktivovaný.`,
      `installment-activated-customer:${plan.id}`
    );
    return { kind: "INSTALLMENT_ACTIVATED" };
  }

  if (decision.kind === "REJECT_INSTALLMENT") {
    assertCaseTransition(
      collectionCase.status as CaseStatus,
      "EMAIL_REMINDER_1_SENT"
    );
    if (input.proposedPlan) {
      await prisma.installmentPlan.update({
        where: { id: input.proposedPlan.id },
        data: { status: "REJECTED" }
      });
    }
    await prisma.case.update({
      where: { id: collectionCase.id },
      data: {
        status: "EMAIL_REMINDER_1_SENT",
        nextActionAt: new Date(),
        automationPausedAt: null,
        automationPauseReason: null
      }
    });
    await recordReplyAction(
      collectionCase.id,
      communication.id,
      decision.kind,
      classification.summary
    );
    return { kind: "INSTALLMENT_REJECTED" };
  }

  if (decision.kind === "PAUSE_DISPUTE") {
    await pauseAutomation(
      collectionCase.id,
      collectionCase.status as CaseStatus,
      "DEBTOR_DISPUTE",
      communication.id,
      classification.summary
    );
    await sendDebtorTemplate(
      collectionCase,
      communication,
      buildDisputeAcknowledgement({ invoiceNumber }),
      "dispute-ack"
    );
    await sendCustomerNotice(
      collectionCase.id,
      collectionCase.organizationId,
      "Dlžník namieta faktúru",
      classification.summary,
      `dispute-customer:${communication.id}`
    );
    return { kind: "PAUSED" };
  }

  if (decision.kind === "PAUSE_MANUAL_REVIEW") {
    await pauseAutomation(
      collectionCase.id,
      collectionCase.status as CaseStatus,
      decision.reason,
      communication.id,
      classification.summary,
      "MANUAL_REVIEW_REQUIRED"
    );
    await sendCustomerNotice(
      collectionCase.id,
      collectionCase.organizationId,
      "Odpoveď vyžaduje manuálnu kontrolu",
      "Dlžník uviedol čiastočnú alebo odlišnú sumu. Automatizácia ju neprijala.",
      `amount-mismatch-customer:${communication.id}`
    );
    return { kind: "PAUSED" };
  }

  if (decision.kind === "REQUEST_CLARIFICATION") {
    await sendDebtorTemplate(
      collectionCase,
      communication,
      buildClarificationRequest({ invoiceNumber }),
      "clarification"
    );
    await ensureClarificationRecorded(
      collectionCase.id,
      communication.id,
      classification.summary
    );
    return { kind: "CLARIFICATION_REQUESTED" };
  }

  await pauseAutomation(
    collectionCase.id,
    collectionCase.status as CaseStatus,
    "REPEATED_UNCLEAR_REPLY",
    communication.id,
    classification.summary
  );
  await sendCustomerNotice(
    collectionCase.id,
    collectionCase.organizationId,
    "Nejasná odpoveď dlžníka",
    classification.summary,
    `unclear-customer:${communication.id}`
  );
  return { kind: "PAUSED" };
}

async function classifyInboundCommunication(
  communication: Awaited<ReturnType<typeof loadReplyCommunication>>
): Promise<DebtorReplyClassification> {
  const stored = debtorReplyClassificationSchema.safeParse(
    communication.aiClassification
  );
  if (stored.success) {
    return stored.data;
  }

  const leaseId = randomUUID();
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
      classificationLeaseId: leaseId,
      classificationLeaseUntil: new Date(Date.now() + 2 * 60_000)
    }
  });
  if (claimed.count !== 1) {
    throw new Error(
      `Communication ${communication.id} already has an active classification lease.`
    );
  }

  const raw = jsonRecord(communication.rawPayload);
  const automated = isAutomatedRawEmail(raw);
  const messageText =
    communication.textBody?.trim() || stripHtml(communication.htmlBody);
  let classification: DebtorReplyClassification;
  try {
    classification = automated
      ? {
          intent: "AUTOMATED_REPLY",
          promisedPaymentDate: null,
          installmentRequested: false,
          explicitInstallmentAcceptance: false,
          mentionedPaymentAmount: null,
          summary: "Automated email response.",
          confidence: 1,
          warnings: []
        }
      : messageText
        ? await createAiProvider().classifyDebtorReply({
            caseId: communication.caseId,
            messageText,
            latestCaseSummary: replyCaseSummary(communication.case)
          })
        : {
            intent: "NEEDS_HUMAN",
            promisedPaymentDate: null,
            installmentRequested: false,
            explicitInstallmentAcceptance: false,
            mentionedPaymentAmount: null,
            summary: "Inbound reply has no readable text body.",
            confidence: 1,
            warnings: ["No readable text body."]
          };

    classification = debtorReplyClassificationSchema.parse(classification);
    await prisma.$transaction(async (tx) => {
      const updated = await tx.communication.updateMany({
        where: { id: communication.id, classificationLeaseId: leaseId },
        data: {
          aiClassification:
            classification as unknown as Prisma.InputJsonValue,
          classificationLeaseId: null,
          classificationLeaseUntil: null
        }
      });
      if (updated.count !== 1) {
        throw new Error("Classification lease was lost.");
      }
      await tx.caseEvent.create({
        data: {
          caseId: communication.caseId,
          actorType: "AI",
          type: CASE_EVENT_TYPES.debtorReplyClassified,
          note: `Debtor reply classified as ${classification.intent}.`,
          payload: {
            communicationId: communication.id,
            classification:
              classification as unknown as Prisma.InputJsonValue
          }
        }
      });
    });
    return classification;
  } catch (error) {
    await prisma.communication
      .updateMany({
        where: { id: communication.id, classificationLeaseId: leaseId },
        data: {
          classificationLeaseId: null,
          classificationLeaseUntil: null
        }
      })
      .catch(() => undefined);
    throw error;
  }
}

async function createInstallmentProposal(
  collectionCase: CollectionCase,
  communication: { id: string }
) {
  if (!collectionCase.amountTotal) {
    throw new Error("Case has no amount for an installment proposal.");
  }
  const existing = await prisma.installmentPlan.findFirst({
    where: {
      caseId: collectionCase.id,
      status: { in: ["PROPOSED", "ACTIVE"] }
    },
    include: { payments: { orderBy: { sequence: "asc" } } }
  });
  if (existing) {
    return existing;
  }

  const schedule = calculateInstallmentSchedule(
    Number(collectionCase.amountTotal),
    new Date()
  );
  assertCaseTransition(
    collectionCase.status as CaseStatus,
    "INSTALLMENT_PLAN_SENT"
  );
  const plan = await prisma.$transaction(async (tx) => {
    const created = await tx.installmentPlan.create({
      data: {
        caseId: collectionCase.id,
        sourceCommunicationId: communication.id,
        totalAmount: collectionCase.amountTotal!,
        currency: collectionCase.currency ?? "EUR",
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
        actorType: "WORKFLOW",
        type: CASE_EVENT_TYPES.installmentProposed,
        note: "Standard three-payment installment plan proposed.",
        payload: { communicationId: communication.id, planId: created.id }
      }
    });
    return created;
  });
  return plan;
}

async function pauseAutomation(
  caseId: string,
  currentStatus: CaseStatus,
  reason: string,
  communicationId: string,
  summary: string,
  status?: "MANUAL_REVIEW_REQUIRED"
): Promise<void> {
  if (status) {
    assertCaseTransition(currentStatus, status);
  }
  await prisma.$transaction([
    prisma.case.update({
      where: { id: caseId },
      data: {
        status,
        nextActionAt: null,
        automationPausedAt: new Date(),
        automationPauseReason: reason
      }
    }),
    prisma.caseEvent.create({
      data: {
        caseId,
        actorType: "WORKFLOW",
        type: CASE_EVENT_TYPES.automationPaused,
        note: summary,
        payload: { communicationId, reason }
      }
    })
  ]);
}

async function sendDebtorTemplate(
  collectionCase: CollectionCase,
  communication: { id: string },
  template: CollectionTemplate,
  kind: string
): Promise<void> {
  const recipient = collectionCase.debtor?.email?.trim();
  if (!recipient) {
    return;
  }
  await sendTrackedEmail({
    caseId: collectionCase.id,
    idempotencyKey: `debtor-response:${kind}:${communication.id}`,
    fromAddress: outboundFromAddress(),
    toAddress: recipient,
    replyTo: caseReplyAddress(collectionCase.id),
    template,
    metadata: {
      caseId: collectionCase.id,
      organizationId: collectionCase.organizationId,
      kind
    },
    rawPayload: {
      kind,
      sourceCommunicationId: communication.id
    }
  });
}

async function sendCustomerNotice(
  caseId: string,
  organizationId: string,
  title: string,
  summary: string,
  idempotencyKey: string
): Promise<void> {
  const collectionCase = await prisma.case.findFirstOrThrow({
    where: { id: caseId, organizationId },
    select: {
      invoiceNumber: true,
      confirmedByUserId: true
    }
  });
  const recipient = await getCustomerCheckRecipient(
    organizationId,
    collectionCase.confirmedByUserId
  );
  if (!recipient) {
    return;
  }
  const publicUrl =
    process.env.NEXTAUTH_URL || process.env.APP_URL || "http://localhost:3000";
  const replyTo = caseClarificationAddress(caseId);
  await sendTrackedEmail({
    caseId,
    idempotencyKey,
    fromAddress: outboundFromAddress(),
    toAddress: recipient,
    replyTo,
    template: buildCustomerExceptionNotice({
      invoiceNumber: collectionCase.invoiceNumber ?? caseId,
      title,
      summary,
      caseUrl: `${publicUrl}/?case=${caseId}`
    }),
    metadata: { caseId, organizationId, kind: "customer-notice" },
    rawPayload: { kind: "customer-notice", title, replyTo }
  });
}

async function recordReplyAction(
  caseId: string,
  communicationId: string,
  action: string,
  note: string
): Promise<void> {
  const existing = await prisma.caseEvent.findFirst({
    where: {
      caseId,
      type: CASE_EVENT_TYPES.debtorReplyActioned,
      payload: {
        path: ["communicationId"],
        equals: communicationId
      }
    },
    select: { id: true }
  });
  if (existing) {
    return;
  }
  await prisma.caseEvent.create({
    data: {
      caseId,
      actorType: "WORKFLOW",
      type: CASE_EVENT_TYPES.debtorReplyActioned,
      note,
      payload: { communicationId, action }
    }
  });
}

async function findOrCreatePaymentCheck(input: {
  caseId: string;
  sourceKey: string;
  reason: PaymentCheckReason;
  installmentPaymentId: string | null;
  expectedAmount: Prisma.Decimal | null;
  currency: string;
}) {
  const existing = await prisma.paymentCheck.findUnique({
    where: { sourceKey: input.sourceKey }
  });
  if (existing) {
    return existing;
  }

  const sequence = await prisma.paymentCheck.count({
    where: { caseId: input.caseId }
  });
  try {
    return await prisma.paymentCheck.create({
      data: {
        caseId: input.caseId,
        sourceKey: input.sourceKey,
        reason: input.reason,
        sequence: sequence + 1,
        installmentPaymentId: input.installmentPaymentId,
        expectedAmount: input.expectedAmount,
        currency: input.currency,
        expiresAt: new Date(Date.now() + paymentCheckTokenTtlMs())
      }
    });
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) {
      throw error;
    }
    return prisma.paymentCheck.findUniqueOrThrow({
      where: { sourceKey: input.sourceKey }
    });
  }
}

function buildPaymentCheckTemplate(input: {
  invoiceNumber: string;
  debtorName: string;
  amount: number | null;
  currency: string;
  dueDate: string;
  installmentSequence: number | null;
  paidUrl: string;
  notPaidUrl: string;
}): CollectionTemplate {
  const subject = input.installmentSequence
    ? `FAKTURIO: prišla ${input.installmentSequence}. splátka?`
    : `FAKTURIO: prišla úhrada faktúry ${input.invoiceNumber}?`;
  const amount = input.amount === null
    ? "nezistená suma"
    : `${input.amount.toFixed(2)} ${input.currency}`;
  const label = input.installmentSequence
    ? `${input.installmentSequence}. splátka`
    : `faktúra ${input.invoiceNumber}`;
  const textBody = [
    "Dobrý deň,",
    "",
    `${label} pre ${input.debtorName} mala termín ${input.dueDate}.`,
    `Očakávaná suma: ${amount}.`,
    "",
    `Platba prišla: ${input.paidUrl}`,
    `Platba neprišla: ${input.notPaidUrl}`
  ].join("\n");
  const htmlBody = [
    "<p>Dobrý deň,</p>",
    `<p>${escapeHtml(label)} pre <strong>${escapeHtml(input.debtorName)}</strong> mala termín ${escapeHtml(input.dueDate)}.</p>`,
    `<p>Očakávaná suma: <strong>${escapeHtml(amount)}</strong></p>`,
    `<p><a href="${escapeHtml(input.paidUrl)}">Platba prišla</a></p>`,
    `<p><a href="${escapeHtml(input.notPaidUrl)}">Platba neprišla</a></p>`
  ].join("");
  return { subject, textBody, htmlBody };
}

type CommunicationDraftData = {
  caseId: string;
  direction: "OUTBOUND";
  channel: "EMAIL";
  status: "DRAFT";
  idempotencyKey: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  rawPayload?: Prisma.InputJsonValue;
};

type CommunicationSendLease = {
  communicationId: string;
  leaseId: string;
};

async function sendTrackedEmail(input: {
  caseId: string;
  idempotencyKey: string;
  fromAddress: string;
  toAddress: string;
  replyTo?: string;
  template: CollectionTemplate;
  metadata: Record<string, string>;
  rawPayload?: Prisma.InputJsonValue;
  onConfirmed?: (
    tx: Prisma.TransactionClient,
    communicationId: string,
    provider: { provider: string; providerId: string }
  ) => Promise<void>;
}): Promise<"SENT" | "ALREADY_SENT"> {
  const draftData: CommunicationDraftData = {
    caseId: input.caseId,
    direction: "OUTBOUND",
    channel: "EMAIL",
    status: "DRAFT",
    idempotencyKey: input.idempotencyKey,
    fromAddress: input.fromAddress,
    toAddress: input.toAddress,
    subject: input.template.subject,
    textBody: input.template.textBody,
    htmlBody: input.template.htmlBody,
    rawPayload: input.rawPayload
  };
  const lease = await acquireCommunicationSendLease(
    input.idempotencyKey,
    draftData
  );
  if (!lease) {
    return "ALREADY_SENT";
  }

  let sent: Awaited<
    ReturnType<ReturnType<typeof createEmailProvider>["sendEmail"]>
  >;
  try {
    sent = await createEmailProvider().sendEmail({
      from: input.fromAddress,
      to: [input.toAddress],
      replyTo: input.replyTo ? [input.replyTo] : undefined,
      subject: input.template.subject,
      textBody: input.template.textBody,
      htmlBody: input.template.htmlBody,
      metadata: input.metadata
    });
  } catch (error) {
    await markCommunicationSendFailed(lease);
    throw error;
  }

  await prisma.$transaction(async (tx) => {
    const confirmed = await tx.communication.updateMany({
      where: {
        id: lease.communicationId,
        sendLeaseId: lease.leaseId,
        status: { in: ["DRAFT", "FAILED"] }
      },
      data: {
        status: "SENT",
        provider: sent.provider,
        providerId: sent.providerId,
        messageId: normalizeMessageId(sent.providerId),
        sentAt: new Date(),
        sendLeaseId: null,
        sendLeaseUntil: null
      }
    });
    if (confirmed.count !== 1) {
      throw new Error(
        `Email send lease for ${lease.communicationId} was lost before confirmation.`
      );
    }
    await input.onConfirmed?.(tx, lease.communicationId, sent);
  });
  return "SENT";
}

async function acquireCommunicationSendLease(
  idempotencyKey: string,
  draftData: CommunicationDraftData
): Promise<CommunicationSendLease | null> {
  const leaseId = randomUUID();
  const now = new Date();
  const sendLeaseUntil = new Date(now.getTime() + PAYMENT_CHECK_SEND_LEASE_MS);
  const existing = await prisma.communication.findUnique({
    where: { idempotencyKey },
    select: { id: true, status: true }
  });

  if (!existing) {
    try {
      const created = await prisma.communication.create({
        data: { ...draftData, sendLeaseId: leaseId, sendLeaseUntil },
        select: { id: true }
      });
      return { communicationId: created.id, leaseId };
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
    }
  } else if (existing.status === "SENT") {
    return null;
  }

  const claimed = await prisma.communication.updateManyAndReturn({
    where: {
      idempotencyKey,
      status: { in: ["DRAFT", "FAILED"] },
      OR: [{ sendLeaseUntil: null }, { sendLeaseUntil: { lt: now } }]
    },
    data: {
      ...draftData,
      status: "DRAFT",
      sendLeaseId: leaseId,
      sendLeaseUntil,
      provider: null,
      providerId: null,
      sentAt: null
    },
    select: { id: true }
  });
  if (claimed.length !== 1) {
    const current = await prisma.communication.findUnique({
      where: { idempotencyKey },
      select: { status: true }
    });
    if (current?.status === "SENT") {
      return null;
    }
    throw new Error(
      `Communication ${idempotencyKey} already has an active send lease.`
    );
  }
  return { communicationId: claimed[0].id, leaseId };
}

async function markCommunicationSendFailed(
  lease: CommunicationSendLease
): Promise<void> {
  await prisma.communication
    .updateMany({
      where: { id: lease.communicationId, sendLeaseId: lease.leaseId },
      data: {
        status: "FAILED",
        sendLeaseId: null,
        sendLeaseUntil: null
      }
    })
    .catch(() => undefined);
}

async function loadCaseForCollection(caseId: string, organizationId: string) {
  const collectionCase = await prisma.case.findUniqueOrThrow({
    where: { id: caseId },
    include: {
      debtor: true,
      customer: true,
      organization: true,
      installmentPlans: {
        where: { status: { in: ["PROPOSED", "ACTIVE"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { payments: { orderBy: { sequence: "asc" } } }
      }
    }
  });
  assertCaseOrganization(
    collectionCase.id,
    collectionCase.organizationId,
    organizationId
  );
  return collectionCase;
}

async function loadReplyCommunication(id: string) {
  return prisma.communication.findUniqueOrThrow({
    where: { id },
    include: {
      case: {
        include: {
          debtor: true,
          customer: true,
          organization: true,
          installmentPlans: {
            where: { status: "PROPOSED" },
            orderBy: { createdAt: "desc" },
            take: 1,
            include: { payments: { orderBy: { sequence: "asc" } } }
          }
        }
      }
    }
  });
}

function replyCaseSummary(
  collectionCase: Awaited<ReturnType<typeof loadReplyCommunication>>["case"]
): string {
  const proposed = collectionCase.installmentPlans[0];
  return [
    `Invoice: ${collectionCase.invoiceNumber ?? "unknown"}`,
    `Amount: ${decimalNumber(collectionCase.amountTotal) ?? "unknown"} ${collectionCase.currency ?? ""}`.trim(),
    `Current status: ${collectionCase.status}`,
    proposed
      ? [
          `Proposed installment plan ${proposed.id}:`,
          ...proposed.payments.map(
            (payment) =>
              `${payment.sequence}: ${Number(payment.amount).toFixed(2)} ${proposed.currency} due ${isoDate(payment.dueDate)}`
          )
        ].join("\n")
      : "No proposed installment plan."
  ].join("\n");
}

function requireInvoiceEmailData(collectionCase: CollectionCase): void {
  if (
    !collectionCase.invoiceNumber ||
    !collectionCase.dueDate ||
    !collectionCase.amountTotal
  ) {
    throw new Error(
      `Case ${collectionCase.id} is missing required invoice email data.`
    );
  }
}

function resolveCreditorName(collectionCase: CollectionCase): string {
  return (
    collectionCase.customer?.name ??
    stringValue(jsonRecord(collectionCase.supplierSnapshot).name) ??
    collectionCase.organization.name
  );
}

async function getCustomerCheckRecipient(
  organizationId: string,
  confirmedByUserId: string | null
): Promise<string | null> {
  if (confirmedByUserId) {
    const membership = await prisma.membership.findFirst({
      where: { organizationId, userId: confirmedByUserId },
      include: { user: true }
    });
    if (membership?.user.email) {
      return membership.user.email;
    }
  }
  const membership = await prisma.membership.findFirst({
    where: { organizationId },
    include: { user: true },
    orderBy: { createdAt: "asc" }
  });
  return membership?.user.email ?? null;
}

async function pauseForMissingContact(
  caseId: string,
  organizationId: string,
  reason: string,
  note: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const changed = await tx.case.updateMany({
      where: {
        id: caseId,
        organizationId,
        OR: [
          { automationPausedAt: null },
          { automationPauseReason: { not: reason } }
        ]
      },
      data: {
        nextActionAt: null,
        automationPausedAt: new Date(),
        automationPauseReason: reason
      }
    });
    if (changed.count === 1) {
      await tx.caseEvent.create({
        data: {
          caseId,
          actorType: "WORKFLOW",
          type: CASE_EVENT_TYPES.automationPaused,
          note,
          payload: { reason }
        }
      });
    }
  });
}

async function clarificationWasAlreadySent(
  communicationId: string
): Promise<boolean> {
  const response = await prisma.communication.findUnique({
    where: {
      idempotencyKey: `debtor-response:clarification:${communicationId}`
    },
    select: { status: true }
  });
  return response?.status === "SENT";
}

async function ensureClarificationRecorded(
  caseId: string,
  communicationId: string,
  note: string
): Promise<void> {
  await prisma.case.updateMany({
    where: { id: caseId, clarificationCount: 0 },
    data: { clarificationCount: 1 }
  });
  await recordReplyAction(
    caseId,
    communicationId,
    "REQUEST_CLARIFICATION",
    note
  );
}

function installmentTemplateRow(payment: {
  sequence: number;
  amount: Prisma.Decimal | number;
  dueDate: Date;
}) {
  return {
    sequence: payment.sequence,
    amount: Number(payment.amount),
    dueDate: isoDate(payment.dueDate)!
  };
}

function isAutomatedRawEmail(raw: Record<string, unknown>): boolean {
  const autoSubmitted = stringValue(raw.autoSubmitted)?.toLowerCase();
  const precedence = stringValue(raw.precedence)?.toLowerCase();
  return (
    (Boolean(autoSubmitted) &&
      autoSubmitted !== "no" &&
      autoSubmitted !== "none") ||
    precedence === "bulk" ||
    precedence === "junk" ||
    precedence === "list"
  );
}

function outboundFromAddress(): string {
  return process.env.SES_FROM_EMAIL || "system@example.com";
}

function caseReplyAddress(caseId: string): string {
  return createCaseReplyAddress(
    { caseId, domain: inboundReplyDomain() },
    requireInboundReplyTokenSecret()
  );
}

function caseClarificationAddress(caseId: string): string {
  return createCaseClarificationAddress(
    { caseId, domain: inboundReplyDomain() },
    requireInboundReplyTokenSecret()
  );
}

function inboundReplyDomain(): string {
  const domain = process.env.INBOUND_REPLY_DOMAIN?.trim();
  if (domain) {
    return domain;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("INBOUND_REPLY_DOMAIN is required in production.");
  }
  return "reply.fakturio.local";
}

function paymentCheckTokenTtlMs(): number {
  const days = Number(process.env.PAYMENT_CHECK_TOKEN_TTL_DAYS);
  return Number.isFinite(days) && days > 0
    ? days * 24 * 60 * 60 * 1000
    : PAYMENT_CHECK_TOKEN_DEFAULT_TTL_MS;
}

function firstReminderPaymentTermDays(): number {
  const configured = Number(process.env.DEBTOR_FIRST_REMINDER_PAYMENT_DAYS);
  return Number.isInteger(configured) && configured >= 0 && configured <= 90
    ? configured
    : FIRST_REMINDER_PAYMENT_TERM_DAYS;
}

function assertCaseOrganization(
  caseId: string,
  actualOrganizationId: string,
  expectedOrganizationId: string
): void {
  if (actualOrganizationId !== expectedOrganizationId) {
    throw new Error(
      `Case ${caseId} belongs to organization ${actualOrganizationId} but workflow expected ${expectedOrganizationId}.`
    );
  }
}

async function assertCaseInOrganization(
  caseId: string,
  expectedOrganizationId: string
): Promise<void> {
  const found = await prisma.case.findUnique({
    where: { id: caseId },
    select: { organizationId: true }
  });
  if (!found) {
    throw new Error(`Case ${caseId} not found.`);
  }
  assertCaseOrganization(caseId, found.organizationId, expectedOrganizationId);
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function jsonRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decimalNumber(
  value: Prisma.Decimal | null | undefined
): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function isoDate(value: Date | null | undefined): string | null {
  return value?.toISOString().slice(0, 10) ?? null;
}

function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  );
}

function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function normalizeMessageId(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^<|>$/g, "").toLowerCase();
  return normalized || null;
}

function stripHtml(value: string | null): string {
  return value?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

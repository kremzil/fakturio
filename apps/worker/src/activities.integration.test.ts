import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@fakturio/db";
import { CASE_EVENT_TYPES } from "@fakturio/shared";
import { activities } from "./activities";

const RUN_ID = `clar-${Date.now().toString(36)}`;
const organizationId = `${RUN_ID}-org`;
const debtorId = `${RUN_ID}-debtor`;
const caseId = `${RUN_ID}-case`;
const communicationId = `${RUN_ID}-communication`;
const originalEmailDriver = process.env.EMAIL_DRIVER;
const originalInboundReplyTokenSecret = process.env.INBOUND_REPLY_TOKEN_SECRET;
const originalInboundReplyDomain = process.env.INBOUND_REPLY_DOMAIN;
const originalMockAi = process.env.MOCK_AI;

beforeAll(async () => {
  process.env.EMAIL_DRIVER = "fixture";
  process.env.MOCK_AI = "1";
  process.env.INBOUND_REPLY_TOKEN_SECRET =
    "test-inbound-reply-secret-with-32-characters";
  process.env.INBOUND_REPLY_DOMAIN = "fakturio.test";
  await prisma.organization.create({
    data: {
      id: organizationId,
      name: "Clarification Org",
      slug: organizationId
    }
  });
  await prisma.debtor.create({
    data: {
      id: debtorId,
      organizationId,
      name: "Clarification Debtor",
      email: "clarification-debtor@example.com"
    }
  });
  await prisma.case.create({
    data: {
      id: caseId,
      organizationId,
      debtorId,
      status: "EMAIL_REMINDER_1_SENT",
      invoiceNumber: "INV-CLARIFY-1",
      amountTotal: 100,
      currency: "EUR"
    }
  });
  await prisma.communication.create({
    data: {
      id: communicationId,
      caseId,
      direction: "INBOUND",
      channel: "EMAIL",
      status: "RECEIVED",
      fromAddress: "clarification-debtor@example.com",
      textBody: "Neviem, ozvem sa.",
      receivedAt: new Date(),
      rawPayload: {
        autoSubmitted: null,
        precedence: null
      },
      aiClassification: {
        intent: "IGNORE_OR_OTHER",
        promisedPaymentDate: null,
        installmentRequested: false,
        explicitInstallmentAcceptance: false,
        requestedInstallmentCount: null,
        mentionedPaymentAmount: null,
        summary: "Unclear debtor reply.",
        confidence: 0.5,
        warnings: []
      }
    }
  });
});

afterAll(async () => {
  if (originalEmailDriver === undefined) {
    delete process.env.EMAIL_DRIVER;
  } else {
    process.env.EMAIL_DRIVER = originalEmailDriver;
  }
  if (originalInboundReplyTokenSecret === undefined) {
    delete process.env.INBOUND_REPLY_TOKEN_SECRET;
  } else {
    process.env.INBOUND_REPLY_TOKEN_SECRET = originalInboundReplyTokenSecret;
  }
  if (originalInboundReplyDomain === undefined) {
    delete process.env.INBOUND_REPLY_DOMAIN;
  } else {
    process.env.INBOUND_REPLY_DOMAIN = originalInboundReplyDomain;
  }
  if (originalMockAi === undefined) {
    delete process.env.MOCK_AI;
  } else {
    process.env.MOCK_AI = originalMockAi;
  }
  await prisma.organization.deleteMany({ where: { id: { startsWith: RUN_ID } } });
  await prisma.user.deleteMany({
    where: {
      email: {
        in: [
          "customer-notice@example.com",
          "custom-customer-notice@example.com",
          "accept-custom-customer@example.com"
        ]
      }
    }
  });
  await prisma.$disconnect();
});

describe("debtor clarification retry", () => {
  it("keeps the first clarification decision idempotent on activity retry", async () => {
    const input = { caseId, organizationId, communicationId };

    const first = await activities.processDebtorReply(input);
    const retry = await activities.processDebtorReply(input);

    expect(first.kind).toBe("CLARIFICATION_REQUESTED");
    expect(retry.kind).toBe("CLARIFICATION_REQUESTED");
    const collectionCase = await prisma.case.findUniqueOrThrow({
      where: { id: caseId }
    });
    expect(collectionCase.clarificationCount).toBe(1);
    expect(collectionCase.automationPausedAt).toBeNull();
    expect(
      await prisma.communication.count({
        where: {
          caseId,
          idempotencyKey: `debtor-response:clarification:${communicationId}`
        }
      })
    ).toBe(1);
    expect(
      await prisma.caseEvent.count({
        where: {
          caseId,
          type: CASE_EVENT_TYPES.debtorReplyActioned,
          payload: {
            path: ["communicationId"],
            equals: communicationId
          }
        }
      })
    ).toBe(1);
  });

  it("sends customer manual-review notices with a case-specific reply address", async () => {
    const noticeOrgId = `${RUN_ID}-notice-org`;
    const noticeUserId = `${RUN_ID}-notice-user`;
    const noticeDebtorId = `${RUN_ID}-notice-debtor`;
    const noticeCaseId = `${RUN_ID}-notice-case`;
    const noticeCommunicationId = `${RUN_ID}-notice-communication`;

    await prisma.organization.create({
      data: {
        id: noticeOrgId,
        name: "Notice Org",
        slug: noticeOrgId,
        memberships: {
          create: {
            user: {
              create: {
                id: noticeUserId,
                email: "customer-notice@example.com"
              }
            }
          }
        }
      }
    });
    await prisma.debtor.create({
      data: {
        id: noticeDebtorId,
        organizationId: noticeOrgId,
        name: "Notice Debtor",
        email: "notice-debtor@example.com"
      }
    });
    await prisma.case.create({
      data: {
        id: noticeCaseId,
        organizationId: noticeOrgId,
        debtorId: noticeDebtorId,
        confirmedByUserId: noticeUserId,
        status: "EMAIL_REMINDER_1_SENT",
        invoiceNumber: "INV-NOTICE-1",
        amountTotal: 100,
        currency: "EUR"
      }
    });
    await prisma.communication.create({
      data: {
        id: noticeCommunicationId,
        caseId: noticeCaseId,
        direction: "INBOUND",
        channel: "EMAIL",
        status: "RECEIVED",
        fromAddress: "notice-debtor@example.com",
        textBody: "Prosím splátky po 25 EUR.",
        receivedAt: new Date(),
        rawPayload: {
          autoSubmitted: null,
          precedence: null
        },
        aiClassification: {
          intent: "INSTALLMENT_REQUEST",
          promisedPaymentDate: null,
          installmentRequested: true,
          explicitInstallmentAcceptance: false,
          requestedInstallmentCount: null,
          mentionedPaymentAmount: 25,
          summary: "Debtor requests installment payments of 25 EUR.",
          confidence: 0.98,
          warnings: []
        }
      }
    });

    const result = await activities.processDebtorReply({
      caseId: noticeCaseId,
      organizationId: noticeOrgId,
      communicationId: noticeCommunicationId
    });

    expect(result.kind).toBe("PAUSED");
    const notice = await prisma.communication.findUniqueOrThrow({
      where: {
        idempotencyKey: `amount-mismatch-customer:${noticeCommunicationId}`
      }
    });
    expect(notice.toAddress).toBe("customer-notice@example.com");
    expect(notice.subject).toContain("potrebujeme rozhodnutie");
    expect(notice.textBody).toContain("Prosím splátky po 25 EUR.");
    expect(notice.textBody).toContain("Dlžník navrhol inú alebo čiastočnú sumu");
    expect(notice.textBody).toContain("Môžete odpovedať priamo na tento email");
    expect(notice.rawPayload).toMatchObject({
      kind: "customer-debtor-reply-decision",
      assistantDrafted: true,
      replyTo: expect.stringMatching(
        new RegExp(`^clarify\\+${noticeCaseId}\\.[a-f0-9]+@fakturio\\.test$`)
      )
    });
  });

  it("can propose installments after a final notice when the debtor asks for a plan", async () => {
    const planOrgId = `${RUN_ID}-plan-org`;
    const planDebtorId = `${RUN_ID}-plan-debtor`;
    const planCaseId = `${RUN_ID}-plan-case`;
    const planCommunicationId = `${RUN_ID}-plan-communication`;

    await prisma.organization.create({
      data: {
        id: planOrgId,
        name: "Plan Org",
        slug: planOrgId
      }
    });
    await prisma.debtor.create({
      data: {
        id: planDebtorId,
        organizationId: planOrgId,
        name: "Plan Debtor s.r.o.",
        email: "plan-debtor@example.com"
      }
    });
    await prisma.case.create({
      data: {
        id: planCaseId,
        organizationId: planOrgId,
        debtorId: planDebtorId,
        status: "FINAL_NOTICE_SENT",
        invoiceNumber: "INV-FINAL-PLAN",
        amountTotal: 900,
        currency: "EUR"
      }
    });
    await prisma.communication.create({
      data: {
        id: planCommunicationId,
        caseId: planCaseId,
        direction: "INBOUND",
        channel: "EMAIL",
        status: "RECEIVED",
        fromAddress: "plan-debtor@example.com",
        textBody: "Dobre, môžem aspoň na splátky platiť?",
        receivedAt: new Date(),
        rawPayload: {
          autoSubmitted: null,
          precedence: null
        },
        aiClassification: {
          intent: "INSTALLMENT_REQUEST",
          promisedPaymentDate: null,
          installmentRequested: true,
          explicitInstallmentAcceptance: false,
          requestedInstallmentCount: null,
          mentionedPaymentAmount: null,
          summary: "Debtor asks whether they can pay in installments.",
          confidence: 0.98,
          warnings: []
        }
      }
    });

    const result = await activities.processDebtorReply({
      caseId: planCaseId,
      organizationId: planOrgId,
      communicationId: planCommunicationId
    });

    expect(result.kind).toBe("INSTALLMENT_PROPOSED");
    const updated = await prisma.case.findUniqueOrThrow({
      where: { id: planCaseId },
      select: { status: true }
    });
    expect(updated.status).toBe("INSTALLMENT_PLAN_SENT");
    const plan = await prisma.installmentPlan.findFirstOrThrow({
      where: { caseId: planCaseId },
      include: { payments: { orderBy: { sequence: "asc" } } }
    });
    expect(plan.payments.map((payment) => Number(payment.amount))).toEqual([
      300,
      300,
      300
    ]);
    const proposal = await prisma.communication.findUniqueOrThrow({
      where: {
        idempotencyKey: `debtor-response:installment-proposal:${planCommunicationId}`
      }
    });
    expect(proposal.toAddress).toBe("plan-debtor@example.com");
    expect(proposal.textBody).toContain("štandardný splátkový kalendár");
    expect(proposal.textBody).toContain("INV-FINAL-PLAN");
  });

  it("pauses for customer decision when the debtor asks to change a proposed installment plan", async () => {
    const customOrgId = `${RUN_ID}-custom-org`;
    const customUserId = `${RUN_ID}-custom-user`;
    const customDebtorId = `${RUN_ID}-custom-debtor`;
    const customCaseId = `${RUN_ID}-custom-case`;
    const customCommunicationId = `${RUN_ID}-custom-communication`;

    await prisma.organization.create({
      data: {
        id: customOrgId,
        name: "Custom Plan Org",
        slug: customOrgId,
        memberships: {
          create: {
            user: {
              create: {
                id: customUserId,
                email: "custom-customer-notice@example.com"
              }
            }
          }
        }
      }
    });
    await prisma.debtor.create({
      data: {
        id: customDebtorId,
        organizationId: customOrgId,
        name: "Custom Plan Debtor s.r.o.",
        email: "custom-plan-debtor@example.com"
      }
    });
    await prisma.case.create({
      data: {
        id: customCaseId,
        organizationId: customOrgId,
        debtorId: customDebtorId,
        confirmedByUserId: customUserId,
        status: "INSTALLMENT_PLAN_SENT",
        invoiceNumber: "INV-CUSTOM-PLAN",
        amountTotal: 1000,
        currency: "EUR",
        installmentPlans: {
          create: {
            totalAmount: 1000,
            currency: "EUR",
            payments: {
              create: [
                { sequence: 1, amount: 333.33, dueDate: new Date("2026-07-01T00:00:00.000Z") },
                { sequence: 2, amount: 333.33, dueDate: new Date("2026-07-15T00:00:00.000Z") },
                { sequence: 3, amount: 333.34, dueDate: new Date("2026-07-29T00:00:00.000Z") }
              ]
            }
          }
        }
      }
    });
    await prisma.communication.create({
      data: {
        id: customCommunicationId,
        caseId: customCaseId,
        direction: "INBOUND",
        channel: "EMAIL",
        status: "RECEIVED",
        fromAddress: "custom-plan-debtor@example.com",
        textBody: "Tento kalendár neprijímam, prosím rozdeliť na 5 splátok.",
        receivedAt: new Date(),
        rawPayload: {
          autoSubmitted: null,
          precedence: null
        },
        aiClassification: {
          intent: "INSTALLMENT_REQUEST",
          promisedPaymentDate: null,
          installmentRequested: true,
          explicitInstallmentAcceptance: false,
          requestedInstallmentCount: 5,
          mentionedPaymentAmount: null,
          summary: "Debtor asks to split the debt into five installments.",
          confidence: 0.98,
          warnings: []
        }
      }
    });

    const result = await activities.processDebtorReply({
      caseId: customCaseId,
      organizationId: customOrgId,
      communicationId: customCommunicationId
    });

    expect(result.kind).toBe("PAUSED");
    const updated = await prisma.case.findUniqueOrThrow({
      where: { id: customCaseId },
      select: { status: true, automationPauseReason: true }
    });
    expect(updated.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(updated.automationPauseReason).toBe("NON_STANDARD_INSTALLMENT_TERMS");
    await expect(
      prisma.communication.findUniqueOrThrow({
        where: {
          idempotencyKey: `debtor-response:installment-proposal:${customCommunicationId}`
        }
      })
    ).rejects.toThrow();
    const notice = await prisma.communication.findUniqueOrThrow({
      where: {
        idempotencyKey: `non-standard-installment-customer:${customCommunicationId}`
      }
    });
    expect(notice.textBody).toContain("5 splátok");
    expect(notice.textBody).toContain("iný splátkový kalendár");
  });

  it("activates the proposed custom installment schedule instead of recalculating the standard one", async () => {
    const acceptOrgId = `${RUN_ID}-aco`;
    const acceptUserId = `${RUN_ID}-acu`;
    const acceptDebtorId = `${RUN_ID}-acd`;
    const acceptCaseId = `${RUN_ID}-acc`;
    const acceptCommunicationId = `${RUN_ID}-acm`;

    await prisma.organization.create({
      data: {
        id: acceptOrgId,
        name: "Accept Custom Plan Org",
        slug: acceptOrgId,
        memberships: {
          create: {
            user: {
              create: {
                id: acceptUserId,
                email: "accept-custom-customer@example.com"
              }
            }
          }
        }
      }
    });
    await prisma.debtor.create({
      data: {
        id: acceptDebtorId,
        organizationId: acceptOrgId,
        name: "Accept Custom Debtor s.r.o.",
        email: "accept-custom-debtor@example.com"
      }
    });
    await prisma.case.create({
      data: {
        id: acceptCaseId,
        organizationId: acceptOrgId,
        debtorId: acceptDebtorId,
        confirmedByUserId: acceptUserId,
        status: "INSTALLMENT_PLAN_SENT",
        invoiceNumber: "INV-ACCEPT-CUSTOM",
        amountTotal: 1000,
        currency: "EUR",
        installmentPlans: {
          create: {
            totalAmount: 1000,
            currency: "EUR",
            payments: {
              create: [
                { sequence: 1, amount: 200, dueDate: new Date("2026-07-06T00:00:00.000Z") },
                { sequence: 2, amount: 200, dueDate: new Date("2026-07-20T00:00:00.000Z") },
                { sequence: 3, amount: 200, dueDate: new Date("2026-08-03T00:00:00.000Z") },
                { sequence: 4, amount: 200, dueDate: new Date("2026-08-17T00:00:00.000Z") },
                { sequence: 5, amount: 200, dueDate: new Date("2026-08-31T00:00:00.000Z") }
              ]
            }
          }
        }
      }
    });
    await prisma.communication.create({
      data: {
        id: acceptCommunicationId,
        caseId: acceptCaseId,
        direction: "INBOUND",
        channel: "EMAIL",
        status: "RECEIVED",
        fromAddress: "accept-custom-debtor@example.com",
        textBody: "Áno, súhlasím.",
        receivedAt: new Date(),
        rawPayload: {
          autoSubmitted: null,
          precedence: null
        },
        aiClassification: {
          intent: "INSTALLMENT_ACCEPTED",
          promisedPaymentDate: null,
          installmentRequested: false,
          explicitInstallmentAcceptance: true,
          requestedInstallmentCount: null,
          mentionedPaymentAmount: null,
          summary: "Debtor explicitly accepts the proposed custom plan.",
          confidence: 0.98,
          warnings: []
        }
      }
    });

    const result = await activities.processDebtorReply({
      caseId: acceptCaseId,
      organizationId: acceptOrgId,
      communicationId: acceptCommunicationId
    });

    expect(result.kind).toBe("INSTALLMENT_ACTIVATED");
    const updated = await prisma.case.findUniqueOrThrow({
      where: { id: acceptCaseId },
      include: {
        installmentPlans: {
          include: { payments: { orderBy: { sequence: "asc" } } }
        }
      }
    });
    expect(updated.status).toBe("INSTALLMENT_ACTIVE");
    expect(updated.nextActionAt?.toISOString()).toBe("2026-07-06T00:00:00.000Z");
    const activePlan = updated.installmentPlans.find((plan) => plan.status === "ACTIVE");
    expect(activePlan?.payments.map((payment) => Number(payment.amount))).toEqual([
      200,
      200,
      200,
      200,
      200
    ]);

    const confirmation = await prisma.communication.findUniqueOrThrow({
      where: {
        idempotencyKey: `debtor-response:installment-activated:${acceptCommunicationId}`
      }
    });
    expect(confirmation.textBody).toContain("1. splátka: 200,00 €");
    expect(confirmation.textBody).toContain("5. splátka: 200,00 €");
    expect(confirmation.textBody).not.toContain("333,33 €");

    const customerNotice = await prisma.communication.findUniqueOrThrow({
      where: {
        idempotencyKey: `installment-activated-customer:${activePlan!.id}`
      }
    });
    expect(customerNotice.textBody).toContain("Splátkový kalendár je aktívny");
    expect(customerNotice.textBody).toContain("2026-07-06");
    expect(customerNotice.textBody).not.toContain("Automatický postup bol pozastavený");

    const event = await prisma.caseEvent.findFirstOrThrow({
      where: {
        caseId: acceptCaseId,
        type: CASE_EVENT_TYPES.installmentActivated
      }
    });
    expect(event.note).toContain("proposed installment plan");
    expect(JSON.stringify(event.payload)).toContain("\"sequence\":5");
  });
});

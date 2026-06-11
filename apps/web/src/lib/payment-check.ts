import {
  CASE_EVENT_TYPES,
  type CaseStatus,
  type PaymentCheckAction,
  requirePaymentCheckTokenSecret,
  resolvePaymentCheckTransition,
  verifyPaymentCheckToken,
  WORKFLOW_COMMAND_TYPES
} from "@fakturio/shared";
import { prisma } from "@fakturio/db";
import type { Prisma } from "@prisma/client";

const NO_STORE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer"
} as const;
const TERMINAL_CASE_STATUSES = new Set([
  "CLOSED_PAID",
  "CLOSED_CANCELLED",
  "CLOSED_UNRESOLVED"
]);

class PaymentCheckConflictError extends Error {}

const ACTION_COPY: Record<
  PaymentCheckAction,
  {
    landingTitle: string;
    landingLead: string;
    submitLabel: string;
    appliedTitle: string;
    appliedMessage: string;
    noopMessage: string;
  }
> = {
  PAID: {
    landingTitle: "Potvrdenie úhrady",
    landingLead: "Potvrďte, že očakávaná platba bola prijatá.",
    submitLabel: "Potvrdiť úhradu",
    appliedTitle: "Platba potvrdená",
    appliedMessage: "Platba bola zaevidovaná.",
    noopMessage: "Táto platba už bola potvrdená."
  },
  NOT_PAID: {
    landingTitle: "Platba neprišla",
    landingLead: "Potvrďte, že očakávaná platba zatiaľ neprišla.",
    submitLabel: "Potvrdiť, že platba neprišla",
    appliedTitle: "Neprijatá platba zaevidovaná",
    appliedMessage: "FAKTURIO bude pokračovať podľa workflow prípadu.",
    noopMessage: "Neprijatá platba už bola zaevidovaná."
  }
};

type LoadedPaymentCheck = NonNullable<
  Awaited<ReturnType<typeof loadPaymentCheck>>
>;
type LegacyCase = NonNullable<Awaited<ReturnType<typeof loadLegacyCase>>>;

export async function handlePaymentCheckGet(
  request: Request,
  caseId: string,
  action: PaymentCheckAction
): Promise<Response> {
  const verification = verifyToken(request, caseId, action);
  if (!verification.ok) {
    return invalidTokenPage(verification.reason);
  }

  if (verification.claims.version === 1) {
    const legacyCase = await loadLegacyCase(
      caseId,
      verification.claims.organizationId
    );
    if (!legacyCase) {
      return page("Prípad neexistuje", "Tento prípad sa nenašiel.", 404);
    }
    const copy = ACTION_COPY[action];
    const token = new URL(request.url).searchParams.get("token")!;
    return page(
      copy.landingTitle,
      `
        <p>${escapeHtml(copy.landingLead)}</p>
        ${legacySummaryHtml(legacyCase)}
        <form method="post" action="${escapeHtml(`?token=${token}`)}">
          <button type="submit" style="display:inline-block;padding:10px 16px;background:#1d1d1b;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:15px">${escapeHtml(copy.submitLabel)}</button>
        </form>
      `,
      200
    );
  }

  const paymentCheck = await loadPaymentCheck(
    verification.claims.paymentCheckId,
    caseId,
    verification.claims.organizationId
  );
  if (!paymentCheck) {
    return page("Kontrola neexistuje", "Táto kontrola platby sa nenašla.", 404);
  }

  const copy = ACTION_COPY[action];
  const token = new URL(request.url).searchParams.get("token")!;
  return page(
    copy.landingTitle,
    `
      <p>${escapeHtml(copy.landingLead)}</p>
      ${summaryHtml(paymentCheck)}
      <form method="post" action="${escapeHtml(`?token=${token}`)}">
        <button type="submit" style="display:inline-block;padding:10px 16px;background:#1d1d1b;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:15px">${escapeHtml(copy.submitLabel)}</button>
      </form>
    `,
    200
  );
}

export async function handlePaymentCheckPost(
  request: Request,
  caseId: string,
  action: PaymentCheckAction
): Promise<Response> {
  const verification = verifyToken(request, caseId, action);
  if (!verification.ok) {
    return invalidTokenPage(verification.reason);
  }

  const result =
    verification.claims.version === 1
      ? await resolveLegacyPaymentCheck({
          caseId,
          organizationId: verification.claims.organizationId,
          action
        })
      : await resolvePaymentCheck({
          paymentCheckId: verification.claims.paymentCheckId,
          caseId,
          organizationId: verification.claims.organizationId,
          action
        });
  const copy = ACTION_COPY[action];

  if (result === "NOT_FOUND") {
    return page("Kontrola neexistuje", "Táto kontrola platby sa nenašla.", 404);
  }
  if (result === "CONFLICT") {
    return page(
      "Kontrola už bola uzavretá",
      "Táto kontrola už bola vyhodnotená opačným výsledkom.",
      409
    );
  }
  if (result === "NOOP") {
    return page(copy.appliedTitle, escapeHtml(copy.noopMessage), 200);
  }
  return page(copy.appliedTitle, escapeHtml(copy.appliedMessage), 200);
}

async function resolveLegacyPaymentCheck(input: {
  caseId: string;
  organizationId: string;
  action: PaymentCheckAction;
}): Promise<"APPLIED" | "NOOP" | "CONFLICT" | "NOT_FOUND"> {
  return prisma.$transaction(async (tx) => {
    const collectionCase = await tx.case.findFirst({
      where: {
        id: input.caseId,
        organizationId: input.organizationId
      },
      select: { status: true }
    });
    if (!collectionCase) {
      return "NOT_FOUND";
    }

    const currentStatus = collectionCase.status as CaseStatus;
    const transition = resolvePaymentCheckTransition(
      input.action,
      currentStatus
    );
    if (transition.outcome === "NOOP") {
      return "NOOP";
    }
    if (transition.outcome === "CONFLICT") {
      return "CONFLICT";
    }

    const changed = await tx.case.updateMany({
      where: {
        id: input.caseId,
        organizationId: input.organizationId,
        status: currentStatus
      },
      data:
        input.action === "PAID"
          ? {
              status: transition.nextStatus,
              closedAt: new Date(),
              nextActionAt: null
            }
          : {
              status: transition.nextStatus,
              nextActionAt: null
            }
    });
    if (changed.count !== 1) {
      return "CONFLICT";
    }

    const event = await tx.caseEvent.create({
      data: {
        caseId: input.caseId,
        actorType: "USER",
        type:
          input.action === "PAID"
            ? CASE_EVENT_TYPES.paymentReceivedConfirmed
            : CASE_EVENT_TYPES.paymentNotReceivedConfirmed,
        note: "Customer resolved a legacy payment-check link.",
        payload: { tokenVersion: 1 }
      }
    });
    await tx.workflowCommand.create({
      data: {
        caseId: input.caseId,
        organizationId: input.organizationId,
        type: WORKFLOW_COMMAND_TYPES.caseStateChanged,
        idempotencyKey: `legacy-payment-check:${event.id}`,
        payload: { status: transition.nextStatus }
      }
    });
    return "APPLIED";
  });
}

async function resolvePaymentCheck(input: {
  paymentCheckId: string;
  caseId: string;
  organizationId: string;
  action: PaymentCheckAction;
}): Promise<"APPLIED" | "NOOP" | "CONFLICT" | "NOT_FOUND"> {
  const targetStatus =
    input.action === "PAID" ? "RESOLVED_PAID" : "RESOLVED_NOT_PAID";
  try {
    const result = await prisma.$transaction(async (tx) => {
    const paymentCheck = await tx.paymentCheck.findFirst({
      where: {
        id: input.paymentCheckId,
        caseId: input.caseId,
        case: { organizationId: input.organizationId }
      },
      include: {
        case: true,
        installmentPayment: {
          include: {
            plan: {
              include: {
                payments: { orderBy: { sequence: "asc" } }
              }
            }
          }
        }
      }
    });
    if (!paymentCheck) {
      return "NOT_FOUND";
    }

    if (
      paymentCheck.status === "RESOLVED_PAID" ||
      paymentCheck.status === "RESOLVED_NOT_PAID"
    ) {
      return paymentCheck.status === targetStatus ? "NOOP" : "CONFLICT";
    }
    if (
      TERMINAL_CASE_STATUSES.has(paymentCheck.case.status) ||
      !isPaymentCheckApplicable(paymentCheck)
    ) {
      return "CONFLICT";
    }

    const claimed = await tx.paymentCheck.updateMany({
      where: {
        id: paymentCheck.id,
        status: { in: ["PENDING", "SENT"] },
        resolvedAt: null
      },
      data: { status: targetStatus, resolvedAt: new Date() }
    });
    if (claimed.count !== 1) {
      const current = await tx.paymentCheck.findUniqueOrThrow({
        where: { id: paymentCheck.id }
      });
      return current.status === targetStatus ? "NOOP" : "CONFLICT";
    }

    if (paymentCheck.installmentPayment) {
      await resolveInstallmentPayment(
        tx,
        {
          caseId: paymentCheck.caseId,
          installmentPayment: paymentCheck.installmentPayment
        },
        input.action
      );
    } else if (input.action === "PAID") {
      const closed = await tx.case.updateMany({
        where: {
          id: paymentCheck.caseId,
          organizationId: input.organizationId,
          status: {
            notIn: ["CLOSED_CANCELLED", "CLOSED_UNRESOLVED"]
          }
        },
        data: {
          status: "CLOSED_PAID",
          closedAt: new Date(),
          nextActionAt: null,
          automationPausedAt: null,
          automationPauseReason: null
        }
      });
      assertSingleUpdate(closed.count);
    } else if (paymentCheck.reason === "DUE_DATE") {
      const overdue = await tx.case.updateMany({
        where: {
          id: paymentCheck.caseId,
          organizationId: input.organizationId,
          status: { in: ["WAITING_FOR_DUE_DATE", "DUE_SOON"] }
        },
        data: { status: "OVERDUE", nextActionAt: null }
      });
      assertSingleUpdate(overdue.count);
    }

    const event = await tx.caseEvent.create({
      data: {
        caseId: paymentCheck.caseId,
        actorType: "USER",
        type:
          input.action === "PAID"
            ? CASE_EVENT_TYPES.paymentReceivedConfirmed
            : CASE_EVENT_TYPES.paymentNotReceivedConfirmed,
        note:
          input.action === "PAID"
            ? `Customer confirmed payment check ${paymentCheck.sequence} as paid.`
            : `Customer confirmed payment check ${paymentCheck.sequence} as not paid.`,
        payload: {
          paymentCheckId: paymentCheck.id,
          reason: paymentCheck.reason,
          installmentPaymentId: paymentCheck.installmentPaymentId
        }
      }
    });
    await tx.workflowCommand.create({
      data: {
        caseId: paymentCheck.caseId,
        organizationId: input.organizationId,
        type: WORKFLOW_COMMAND_TYPES.paymentCheckResolved,
        idempotencyKey: `payment-check-result:${event.id}`,
        payload: { paymentCheckId: paymentCheck.id }
      }
    });

      return "APPLIED";
    });
    if (result === "CONFLICT") {
      return normalizeConcurrentPaymentCheckResult(input, targetStatus);
    }
    return result;
  } catch (error) {
    if (error instanceof PaymentCheckConflictError) {
      return normalizeConcurrentPaymentCheckResult(input, targetStatus);
    }
    throw error;
  }
}

async function normalizeConcurrentPaymentCheckResult(
  input: {
    paymentCheckId: string;
    caseId: string;
    organizationId: string;
  },
  targetStatus: "RESOLVED_PAID" | "RESOLVED_NOT_PAID"
): Promise<"NOOP" | "CONFLICT"> {
  const current = await prisma.paymentCheck.findFirst({
    where: {
      id: input.paymentCheckId,
      caseId: input.caseId,
      case: { organizationId: input.organizationId }
    },
    select: { status: true }
  });
  return current?.status === targetStatus ? "NOOP" : "CONFLICT";
}

async function resolveInstallmentPayment(
  tx: Prisma.TransactionClient,
  paymentCheck: {
    caseId: string;
    installmentPayment: {
      id: string;
      sequence: number;
      planId: string;
      plan: {
        payments: Array<{
          id: string;
          status: string;
          dueDate: Date;
        }>;
      };
    };
  },
  action: PaymentCheckAction
): Promise<void> {
  const installment = paymentCheck.installmentPayment;
  if (action === "NOT_PAID") {
    const missed = await tx.installmentPayment.updateMany({
      where: { id: installment.id, status: "PENDING" },
      data: { status: "MISSED", missedAt: new Date() }
    });
    const broken = await tx.installmentPlan.updateMany({
      where: { id: installment.planId, status: "ACTIVE" },
      data: { status: "BROKEN", brokenAt: new Date() }
    });
    const caseBroken = await tx.case.updateMany({
      where: {
        id: paymentCheck.caseId,
        status: "INSTALLMENT_ACTIVE"
      },
      data: {
        status: "INSTALLMENT_BROKEN",
        nextActionAt: null
      }
    });
    assertSingleUpdate(missed.count, broken.count, caseBroken.count);
    await tx.caseEvent.create({
      data: {
        caseId: paymentCheck.caseId,
        actorType: "USER",
        type: CASE_EVENT_TYPES.installmentBroken,
        note: `${installment.sequence}. installment was not received.`,
        payload: {
          planId: installment.planId,
          installmentPaymentId: installment.id
        }
      }
    });
    return;
  }

  const paid = await tx.installmentPayment.updateMany({
    where: { id: installment.id, status: "PENDING" },
    data: { status: "PAID", paidAt: new Date() }
  });
  const nextPayment = installment.plan.payments.find(
    (payment) =>
      payment.id !== installment.id && payment.status === "PENDING"
  );
  if (!nextPayment) {
    const completed = await tx.installmentPlan.updateMany({
      where: { id: installment.planId, status: "ACTIVE" },
      data: { status: "COMPLETED", completedAt: new Date() }
    });
    const closed = await tx.case.updateMany({
      where: {
        id: paymentCheck.caseId,
        status: "INSTALLMENT_ACTIVE"
      },
      data: {
        status: "CLOSED_PAID",
        closedAt: new Date(),
        nextActionAt: null
      }
    });
    assertSingleUpdate(paid.count, completed.count, closed.count);
  } else {
    const advanced = await tx.case.updateMany({
      where: {
        id: paymentCheck.caseId,
        status: "INSTALLMENT_ACTIVE"
      },
      data: {
        status: "INSTALLMENT_ACTIVE",
        nextActionAt: nextPayment.dueDate
      }
    });
    assertSingleUpdate(paid.count, advanced.count);
  }
  await tx.caseEvent.create({
    data: {
      caseId: paymentCheck.caseId,
      actorType: "USER",
      type: CASE_EVENT_TYPES.installmentPaymentConfirmed,
      note: `${installment.sequence}. installment was confirmed as paid.`,
      payload: {
        planId: installment.planId,
        installmentPaymentId: installment.id
      }
    }
  });
}

function isPaymentCheckApplicable(paymentCheck: {
  reason: string;
  case: { status: string };
  installmentPayment: null | {
    status: string;
    plan: { status: string };
  };
}): boolean {
  if (paymentCheck.installmentPayment) {
    return (
      paymentCheck.case.status === "INSTALLMENT_ACTIVE" &&
      paymentCheck.installmentPayment.status === "PENDING" &&
      paymentCheck.installmentPayment.plan.status === "ACTIVE"
    );
  }

  switch (paymentCheck.reason) {
    case "DUE_DATE":
      return (
        paymentCheck.case.status === "WAITING_FOR_DUE_DATE" ||
        paymentCheck.case.status === "DUE_SOON"
      );
    case "FOLLOW_UP":
      return paymentCheck.case.status === "EMAIL_REMINDER_1_SENT";
    case "PROMISE_DUE":
      return paymentCheck.case.status === "PAYMENT_PROMISED";
    case "DEBTOR_CLAIMED_PAID":
      return !TERMINAL_CASE_STATUSES.has(paymentCheck.case.status);
    default:
      return false;
  }
}

function assertSingleUpdate(...counts: number[]): void {
  if (counts.some((count) => count !== 1)) {
    throw new PaymentCheckConflictError(
      "Payment check state changed concurrently."
    );
  }
}

function verifyToken(
  request: Request,
  caseId: string,
  action: PaymentCheckAction
) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return { ok: false as const, reason: "MALFORMED" as const };
  }
  return verifyPaymentCheckToken(
    token,
    requirePaymentCheckTokenSecret(),
    { expectedCaseId: caseId, expectedAction: action }
  );
}

async function loadPaymentCheck(
  paymentCheckId: string,
  caseId: string,
  organizationId: string
) {
  return prisma.paymentCheck.findFirst({
    where: {
      id: paymentCheckId,
      caseId,
      case: { organizationId }
    },
    include: {
      case: { include: { debtor: true } },
      installmentPayment: true
    }
  });
}

async function loadLegacyCase(caseId: string, organizationId: string) {
  return prisma.case.findFirst({
    where: { id: caseId, organizationId },
    include: { debtor: true }
  });
}

function legacySummaryHtml(collectionCase: LegacyCase): string {
  const amount = collectionCase.amountTotal
    ? `${Number(collectionCase.amountTotal).toFixed(2)} ${collectionCase.currency ?? ""}`.trim()
    : "nezistená suma";
  return `
    <table style="border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:2px 12px 2px 0;color:#666">Faktúra</td><td>${escapeHtml(collectionCase.invoiceNumber ?? "—")}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">Dlžník</td><td>${escapeHtml(collectionCase.debtor?.name ?? "—")}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">Suma</td><td>${escapeHtml(amount)}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">Splatnosť</td><td>${escapeHtml(collectionCase.dueDate?.toISOString().slice(0, 10) ?? "—")}</td></tr>
    </table>`;
}

function summaryHtml(paymentCheck: LoadedPaymentCheck): string {
  const amount = paymentCheck.expectedAmount
    ? `${Number(paymentCheck.expectedAmount).toFixed(2)} ${paymentCheck.currency ?? ""}`.trim()
    : "nezistená suma";
  const label = paymentCheck.installmentPayment
    ? `${paymentCheck.installmentPayment.sequence}. splátka`
    : paymentCheck.case.invoiceNumber ?? "—";
  const dueDate =
    paymentCheck.installmentPayment?.dueDate ??
    paymentCheck.case.dueDate;
  return `
    <table style="border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:2px 12px 2px 0;color:#666">Platba</td><td>${escapeHtml(label)}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">Dlžník</td><td>${escapeHtml(paymentCheck.case.debtor?.name ?? "—")}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">Suma</td><td>${escapeHtml(amount)}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">Termín</td><td>${escapeHtml(dueDate?.toISOString().slice(0, 10) ?? "—")}</td></tr>
    </table>`;
}

function invalidTokenPage(reason: string): Response {
  return page(
    reason === "EXPIRED" ? "Odkaz expiroval" : "Neplatný odkaz",
    reason === "EXPIRED"
      ? "Platnosť tohto odkazu uplynula. Stav aktualizujte vo FAKTURIO."
      : "Tento odkaz nie je platný.",
    400
  );
}

function page(title: string, bodyHtml: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>body{font-family:Arial,sans-serif;margin:48px;color:#1d1d1b;max-width:560px}a{color:#1d1d1b}</style></head><body><h1>${escapeHtml(title)}</h1>${bodyHtml}<p style="margin-top:24px"><a href="/">Späť do FAKTURIO</a></p></body></html>`,
    { status, headers: NO_STORE_HEADERS }
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

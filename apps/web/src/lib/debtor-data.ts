import type { Prisma } from "@prisma/client";
import { prisma } from "@fakturio/db";
import {
  dashboardCaseSummaryInclude,
  demoCases,
  toDashboardCase,
  type DashboardCase
} from "./case-data";

const TERMINAL_CASE_STATUSES = new Set([
  "CLOSED_PAID",
  "CLOSED_CANCELLED",
  "CLOSED_UNRESOLVED"
]);

const debtorSummaryInclude = {
  cases: {
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      amountTotal: true,
      currency: true,
      createdAt: true
    }
  }
} satisfies Prisma.DebtorInclude;

const debtorDetailInclude = {
  cases: {
    orderBy: { createdAt: "desc" },
    include: dashboardCaseSummaryInclude
  }
} satisfies Prisma.DebtorInclude;

type DebtorSummaryRecord = Prisma.DebtorGetPayload<{
  include: typeof debtorSummaryInclude;
}>;

type DebtorDetailRecord = Prisma.DebtorGetPayload<{
  include: typeof debtorDetailInclude;
}>;

type DebtorCaseAggregate = {
  status: string;
  amountTotal: { toString(): string } | null;
  currency: string | null;
  createdAt: Date;
};

export type DashboardDebtorAmount = {
  currency: string;
  amount: number;
};

export type DashboardDebtor = {
  id: string;
  name: string;
  email: string | null;
  ico: string | null;
  dic: string | null;
  icDph: string | null;
  address: string | null;
  caseCount: number;
  openCaseCount: number;
  closedCaseCount: number;
  openAmounts: DashboardDebtorAmount[];
  lastCaseAt: string | null;
};

export type DashboardDebtorDetail = DashboardDebtor & {
  cases: DashboardCase[];
};

export async function getDashboardDebtors(
  organizationId: string
): Promise<DashboardDebtor[]> {
  try {
    const debtors = await prisma.debtor.findMany({
      where: { organizationId },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: debtorSummaryInclude
    });

    return debtors.map((debtor) => toDashboardDebtor(debtor, debtor.cases));
  } catch (error) {
    if (process.env.NODE_ENV === "production") {
      throw error;
    }
    return demoDebtors;
  }
}

export async function getDashboardDebtorById(
  debtorId: string,
  organizationId: string
): Promise<DashboardDebtorDetail | null> {
  const debtor = await prisma.debtor.findFirst({
    where: { id: debtorId, organizationId },
    include: debtorDetailInclude
  });

  if (!debtor) {
    return null;
  }

  return {
    ...toDashboardDebtor(debtor, debtor.cases),
    cases: debtor.cases.map(toDashboardCase)
  };
}

function toDashboardDebtor(
  debtor: DebtorSummaryRecord | DebtorDetailRecord,
  cases: DebtorCaseAggregate[]
): DashboardDebtor {
  const openAmounts = new Map<string, number>();
  let openCaseCount = 0;

  for (const item of cases) {
    if (TERMINAL_CASE_STATUSES.has(item.status)) {
      continue;
    }
    openCaseCount += 1;
    if (item.amountTotal !== null) {
      const currency = item.currency ?? "EUR";
      openAmounts.set(
        currency,
        (openAmounts.get(currency) ?? 0) + Number(item.amountTotal)
      );
    }
  }

  return {
    id: debtor.id,
    name: debtor.name,
    email: debtor.email,
    ico: debtor.ico,
    dic: debtor.dic,
    icDph: debtor.icDph,
    address: debtor.address,
    caseCount: cases.length,
    openCaseCount,
    closedCaseCount: cases.length - openCaseCount,
    openAmounts: [...openAmounts.entries()]
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((left, right) => left.currency.localeCompare(right.currency)),
    lastCaseAt: cases[0]?.createdAt.toISOString() ?? null
  };
}

const demoDebtors: DashboardDebtor[] = [
  {
    id: "demo-debtor-1",
    name: demoCases[0]?.debtorName ?? "Ukážkový dlžník",
    email: demoCases[0]?.debtorEmail ?? null,
    ico: null,
    dic: null,
    icDph: null,
    address: null,
    caseCount: 1,
    openCaseCount: 1,
    closedCaseCount: 0,
    openAmounts: [
      {
        currency: demoCases[0]?.currency ?? "EUR",
        amount: demoCases[0]?.amountTotal ?? 0
      }
    ],
    lastCaseAt: demoCases[0]?.createdAt ?? null
  }
];

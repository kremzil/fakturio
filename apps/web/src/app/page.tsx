import { Dashboard } from "@/components/dashboard";
import {
  getDashboardCaseById,
  getDashboardCases
} from "@/lib/case-data";
import { getDashboardDebtors } from "@/lib/debtor-data";
import { requireSession } from "@/lib/session";
import { prisma } from "@fakturio/db";

export const dynamic = "force-dynamic";

export default async function Page() {
  const { organizationId } = await requireSession();
  const [summaries, debtors, organization] = await Promise.all([
    getDashboardCases(organizationId),
    getDashboardDebtors(organizationId),
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true }
    })
  ]);
  const firstDetail = summaries[0]
    ? await getDashboardCaseById(summaries[0].id, organizationId)
    : null;
  const cases = firstDetail
    ? [firstDetail, ...summaries.slice(1)]
    : summaries;

  return (
    <Dashboard
      initialCases={cases}
      initialDebtors={debtors}
      organizationName={organization?.name ?? "FAKTURIO"}
    />
  );
}

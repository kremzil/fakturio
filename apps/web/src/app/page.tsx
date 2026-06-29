import { Dashboard } from "@/components/dashboard";
import {
  getDashboardCaseById,
  getDashboardCases
} from "@/lib/case-data";
import { getDashboardDebtors } from "@/lib/debtor-data";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Page() {
  const { organizationId } = await requireSession();
  const [summaries, debtors] = await Promise.all([
    getDashboardCases(organizationId),
    getDashboardDebtors(organizationId)
  ]);
  const firstDetail = summaries[0]
    ? await getDashboardCaseById(summaries[0].id, organizationId)
    : null;
  const cases = firstDetail
    ? [firstDetail, ...summaries.slice(1)]
    : summaries;

  return <Dashboard initialCases={cases} initialDebtors={debtors} />;
}

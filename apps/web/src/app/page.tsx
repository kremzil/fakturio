import { Dashboard } from "@/components/dashboard";
import { getDashboardCases } from "@/lib/case-data";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Page() {
  const { organizationId } = await requireSession();
  const cases = await getDashboardCases(organizationId);

  return <Dashboard initialCases={cases} />;
}

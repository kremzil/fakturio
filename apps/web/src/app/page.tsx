import { Dashboard } from "@/components/dashboard";
import { getDashboardCases } from "@/lib/case-data";

export const dynamic = "force-dynamic";

export default async function Page() {
  const cases = await getDashboardCases();

  return <Dashboard initialCases={cases} />;
}

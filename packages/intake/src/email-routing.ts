import { prisma } from "@fakturio/db";
import type { InboundEmail } from "@fakturio/email";

export type EmailOrganizationRoute = {
  organizationId: string;
  matchedAddress: string;
};

export async function resolveOrganizationForInboundEmail(email: InboundEmail): Promise<EmailOrganizationRoute | null> {
  const addresses = email.to.map(normalizeEmailAddress).filter((value): value is string => Boolean(value));
  if (addresses.length === 0) {
    return null;
  }

  const route = await prisma.emailIntakeAddress.findFirst({
    where: {
      address: { in: addresses },
      active: true
    },
    orderBy: { createdAt: "asc" }
  });

  return route ? { organizationId: route.organizationId, matchedAddress: route.address } : null;
}

export function normalizeEmailAddress(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

import { prisma } from "./client";

export const LOCAL_ORG_ID = "local-org";
export const LOCAL_USER_ID = "local-user";

export async function ensureLocalBootstrap() {
  const organization = await prisma.organization.upsert({
    where: { id: LOCAL_ORG_ID },
    update: {},
    create: {
      id: LOCAL_ORG_ID,
      name: "Local FAKTURIO Workspace",
      slug: "local"
    }
  });

  const user = await prisma.user.upsert({
    where: { id: LOCAL_USER_ID },
    update: {},
    create: {
      id: LOCAL_USER_ID,
      name: "Local User",
      email: "local-user@fakturio.test"
    }
  });

  await prisma.membership.upsert({
    where: {
      organizationId_userId: {
        organizationId: organization.id,
        userId: user.id
      }
    },
    update: {},
    create: {
      organizationId: organization.id,
      userId: user.id,
      role: "OWNER"
    }
  });

  await prisma.emailIntakeAddress.upsert({
    where: { address: "invoices@fakturio.local" },
    update: { organizationId: organization.id, active: true, provider: "fixture" },
    create: {
      organizationId: organization.id,
      address: "invoices@fakturio.local",
      provider: "fixture"
    }
  });

  return { organization, user };
}

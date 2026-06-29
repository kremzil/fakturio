import { prisma } from "./client";

export const LOCAL_ORG_ID = "local-org";
export const LOCAL_USER_ID = "local-user";

export async function ensureLocalBootstrap() {
  const localUserEmail = configuredLocalUserEmail();
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
    update: {
      email: localUserEmail
    },
    create: {
      id: LOCAL_USER_ID,
      name: "Local User",
      email: localUserEmail
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

  for (const address of configuredInboundIntakeAddresses()) {
    await prisma.emailIntakeAddress.upsert({
      where: { address },
      update: {
        organizationId: organization.id,
        active: true,
        provider: "ses"
      },
      create: {
        organizationId: organization.id,
        address,
        provider: "ses"
      }
    });
  }

  return { organization, user };
}

function configuredLocalUserEmail(): string {
  return (process.env.LOCAL_USER_EMAIL || "local-user@fakturio.test")
    .trim()
    .toLowerCase();
}

function configuredInboundIntakeAddresses(): string[] {
  return (process.env.INBOUND_INTAKE_ADDRESSES || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

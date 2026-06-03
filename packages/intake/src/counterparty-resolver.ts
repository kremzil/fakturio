import type { Customer, Debtor } from "@prisma/client";
import { prisma } from "@fakturio/db";
import type { Party } from "@fakturio/shared";

export type CounterpartyMatchMethod =
  | "CREATED"
  | "ICO"
  | "IC_DPH"
  | "DIC"
  | "EMAIL"
  | "NAME_ADDRESS"
  | "UNIQUE_NAME";

export type ResolvedCustomer = {
  customer: Customer;
  matchMethod: CounterpartyMatchMethod;
  created: boolean;
};

export type ResolvedDebtor = {
  debtor: Debtor;
  matchMethod: CounterpartyMatchMethod;
  created: boolean;
};

export async function resolveCustomer(organizationId: string, party: Party): Promise<ResolvedCustomer | null> {
  const normalized = normalizeParty(party);
  if (!normalized.name) {
    return null;
  }
  const name = normalized.name;

  const matched = await findCustomer(organizationId, normalized);
  if (matched) {
    const customer = await prisma.customer.update({
      where: { id: matched.customer.id },
      data: { name, ...customerPatch(party, normalized) }
    });
    return { customer, matchMethod: matched.matchMethod, created: false };
  }

  const customer = await prisma.customer.create({
    data: {
      organizationId,
      name,
      ...customerPatch(party, normalized)
    }
  });
  return { customer, matchMethod: "CREATED", created: true };
}

export async function resolveDebtor(organizationId: string, party: Party): Promise<ResolvedDebtor | null> {
  const normalized = normalizeParty(party);
  if (!normalized.name) {
    return null;
  }
  const name = normalized.name;

  const matched = await findDebtor(organizationId, normalized);
  if (matched) {
    const debtor = await prisma.debtor.update({
      where: { id: matched.debtor.id },
      data: { name, ...debtorPatch(party, normalized) }
    });
    return { debtor, matchMethod: matched.matchMethod, created: false };
  }

  const debtor = await prisma.debtor.create({
    data: {
      organizationId,
      name,
      ...debtorPatch(party, normalized)
    }
  });
  return { debtor, matchMethod: "CREATED", created: true };
}

export type NormalizedParty = {
  name: string | null;
  email: string | null;
  normalizedName: string | null;
  normalizedAddress: string | null;
  ico: string | null;
  dic: string | null;
  icDph: string | null;
  address: string | null;
};

export function normalizeParty(party: Party): NormalizedParty {
  return {
    name: cleanText(party.name),
    email: normalizeEmail(party.email),
    normalizedName: normalizeSearchText(party.name),
    normalizedAddress: normalizeSearchText(party.address),
    ico: normalizeIdentifier(party.ico),
    dic: normalizeIdentifier(party.dic),
    icDph: normalizeIdentifier(party.icDph),
    address: cleanText(party.address)
  };
}

export function normalizeSearchText(value: string | null | undefined): string | null {
  const cleaned = cleanText(value);
  if (!cleaned) {
    return null;
  }

  const normalized = cleaned
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  return normalized || null;
}

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  return cleanText(value)?.toLowerCase() ?? null;
}

function normalizeIdentifier(value: string | null | undefined): string | null {
  const normalized = cleanText(value)
    ?.toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return normalized || null;
}

async function findCustomer(
  organizationId: string,
  party: NormalizedParty
): Promise<{ customer: Customer; matchMethod: CounterpartyMatchMethod } | null> {
  if (party.ico) {
    const customer = await prisma.customer.findFirst({ where: { organizationId, ico: party.ico }, orderBy: { createdAt: "asc" } });
    if (customer) return { customer, matchMethod: "ICO" };
  }
  if (party.icDph) {
    const customer = await prisma.customer.findFirst({ where: { organizationId, icDph: party.icDph }, orderBy: { createdAt: "asc" } });
    if (customer) return { customer, matchMethod: "IC_DPH" };
  }
  if (party.dic) {
    const customer = await prisma.customer.findFirst({ where: { organizationId, dic: party.dic }, orderBy: { createdAt: "asc" } });
    if (customer) return { customer, matchMethod: "DIC" };
  }
  if (party.email) {
    const customer = await prisma.customer.findFirst({ where: { organizationId, email: party.email }, orderBy: { createdAt: "asc" } });
    if (customer) return { customer, matchMethod: "EMAIL" };
  }
  if (party.normalizedName && party.normalizedAddress) {
    const customer = await prisma.customer.findFirst({
      where: { organizationId, normalizedName: party.normalizedName, normalizedAddress: party.normalizedAddress },
      orderBy: { createdAt: "asc" }
    });
    if (customer) return { customer, matchMethod: "NAME_ADDRESS" };
  }
  if (party.normalizedName) {
    const customers = await prisma.customer.findMany({
      where: { organizationId, normalizedName: party.normalizedName },
      take: 2
    });
    if (customers.length === 1) return { customer: customers[0], matchMethod: "UNIQUE_NAME" };
  }

  return null;
}

async function findDebtor(
  organizationId: string,
  party: NormalizedParty
): Promise<{ debtor: Debtor; matchMethod: CounterpartyMatchMethod } | null> {
  if (party.ico) {
    const debtor = await prisma.debtor.findFirst({ where: { organizationId, ico: party.ico }, orderBy: { createdAt: "asc" } });
    if (debtor) return { debtor, matchMethod: "ICO" };
  }
  if (party.icDph) {
    const debtor = await prisma.debtor.findFirst({ where: { organizationId, icDph: party.icDph }, orderBy: { createdAt: "asc" } });
    if (debtor) return { debtor, matchMethod: "IC_DPH" };
  }
  if (party.dic) {
    const debtor = await prisma.debtor.findFirst({ where: { organizationId, dic: party.dic }, orderBy: { createdAt: "asc" } });
    if (debtor) return { debtor, matchMethod: "DIC" };
  }
  if (party.email) {
    const debtor = await prisma.debtor.findFirst({ where: { organizationId, email: party.email }, orderBy: { createdAt: "asc" } });
    if (debtor) return { debtor, matchMethod: "EMAIL" };
  }
  if (party.normalizedName && party.normalizedAddress) {
    const debtor = await prisma.debtor.findFirst({
      where: { organizationId, normalizedName: party.normalizedName, normalizedAddress: party.normalizedAddress },
      orderBy: { createdAt: "asc" }
    });
    if (debtor) return { debtor, matchMethod: "NAME_ADDRESS" };
  }
  if (party.normalizedName) {
    const debtors = await prisma.debtor.findMany({
      where: { organizationId, normalizedName: party.normalizedName },
      take: 2
    });
    if (debtors.length === 1) return { debtor: debtors[0], matchMethod: "UNIQUE_NAME" };
  }

  return null;
}

function customerPatch(party: Party, normalized: NormalizedParty) {
  return {
    email: normalized.email ?? undefined,
    normalizedName: normalized.normalizedName ?? undefined,
    normalizedAddress: normalized.normalizedAddress ?? undefined,
    ico: normalized.ico ?? undefined,
    dic: normalized.dic ?? undefined,
    icDph: normalized.icDph ?? undefined,
    address: cleanText(party.address) ?? undefined
  };
}

function debtorPatch(party: Party, normalized: NormalizedParty) {
  return {
    email: normalized.email ?? undefined,
    normalizedName: normalized.normalizedName ?? undefined,
    normalizedAddress: normalized.normalizedAddress ?? undefined,
    ico: normalized.ico ?? undefined,
    dic: normalized.dic ?? undefined,
    icDph: normalized.icDph ?? undefined,
    address: cleanText(party.address) ?? undefined
  };
}

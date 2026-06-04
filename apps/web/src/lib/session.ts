import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/auth";
import { ensureLocalBootstrap, prisma } from "@fakturio/db";

export type OrganizationContext = {
  userId: string;
  organizationId: string;
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Single source of truth for "who is calling" on authenticated dashboard/API routes.
 *
 * Production: resolves the user from the Auth.js session and their organization membership.
 * There is NO local-user fallback in production.
 *
 * Development: falls back to the bootstrapped local organization so the dashboard works
 * without a configured identity provider.
 */
export async function requireSession(): Promise<OrganizationContext> {
  const session = await auth();
  const userId = session?.user?.id;

  if (userId) {
    const organizationId = await resolveActiveOrganization(userId, session?.user?.organizationId);
    return { userId, organizationId };
  }

  if (process.env.NODE_ENV !== "production") {
    const { organization, user } = await ensureLocalBootstrap();
    return { userId: user.id, organizationId: organization.id };
  }

  throw new HttpError(401, "Authentication required.");
}

/**
 * Resolves which organization the request acts in.
 *
 * If the session carries an explicit active organization, it is honored only after verifying
 * the user is actually a member of it (never trust the claim alone). Otherwise we fall back to
 * the user's single membership. Users with multiple memberships and no explicit selection are
 * pinned to their oldest membership; switching organizations requires an explicit active-org
 * selection in the session, which the caller must set through a verified flow.
 */
async function resolveActiveOrganization(
  userId: string,
  requestedOrganizationId: string | undefined
): Promise<string> {
  if (requestedOrganizationId) {
    const membership = await prisma.membership.findFirst({
      where: { userId, organizationId: requestedOrganizationId },
      select: { organizationId: true }
    });

    if (!membership) {
      throw new HttpError(403, "User is not a member of the requested organization.");
    }

    return membership.organizationId;
  }

  const memberships = await prisma.membership.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true }
  });

  if (memberships.length === 0) {
    throw new HttpError(403, "User is not a member of any organization.");
  }

  return memberships[0].organizationId;
}

export function httpErrorResponse(error: unknown): NextResponse {
  if (error instanceof HttpError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  // Request validation failures are client errors (400), but we never echo the raw Zod text
  // back to the caller — return a stable, generic message and surface field paths only.
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: "Neplatné údaje požiadavky.",
        fields: error.issues.map((issue) => issue.path.join(".")).filter(Boolean)
      },
      { status: 400 }
    );
  }

  // Unknown DB/runtime errors must not leak internal messages to the client. Log server-side
  // and return an opaque 500.
  console.error("Unhandled API error:", error);
  return NextResponse.json({ error: "Vyskytla sa neočakávaná chyba." }, { status: 500 });
}

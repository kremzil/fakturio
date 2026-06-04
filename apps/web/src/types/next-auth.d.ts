import type { DefaultSession } from "next-auth";

/**
 * Type augmentation for Auth.js.
 *
 * `organizationId` is the optional active organization selected for the session. It is only
 * trusted after membership is re-verified server-side (see resolveActiveOrganization). A future
 * verified org-switch flow can set it on the JWT/session; until then it stays undefined and the
 * user falls back to their single membership.
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      organizationId?: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    organizationId?: string;
  }
}

export {};

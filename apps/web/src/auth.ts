import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@fakturio/db";

/**
 * Local development sign-in only. This provider performs NO password verification and always
 * resolves to the bootstrapped local user, so it must never be enabled in production where it
 * would let anyone assume that user's organization. A real identity provider must be wired up
 * before going to production.
 */
const developmentProviders =
  process.env.NODE_ENV === "production"
    ? []
    : [
        Credentials({
          name: "Local development",
          credentials: {
            email: { label: "Email", type: "email" }
          },
          async authorize(credentials) {
            const email =
              typeof credentials?.email === "string"
                ? credentials.email
                : process.env.LOCAL_USER_EMAIL || "local-user@fakturio.test";

            return {
              id: "local-user",
              email,
              name: "Local User"
            };
          }
        })
      ];

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  providers: developmentProviders,
  callbacks: {
    jwt({ token, user, trigger, session }) {
      if (user?.id) {
        token.sub = user.id;
      }
      // Allow a verified org-switch flow to set the active organization via session update.
      // requireSession() always re-verifies membership before trusting this value, so a stale
      // or forged token can never grant access to an organization the user does not belong to.
      if (trigger === "update" && session && typeof session.organizationId === "string") {
        token.organizationId = session.organizationId;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      if (session.user) {
        session.user.organizationId =
          typeof token.organizationId === "string" ? token.organizationId : undefined;
      }
      return session;
    }
  }
});

/**
 * Next.js calls register() once on server startup. We validate the payment-check token secret
 * here so the web app fails fast in production (mirroring the worker), rather than only erroring
 * with a 500 when a recipient clicks a payment-check link. A mismatched/missing secret would
 * otherwise let the worker send signed links the web app cannot verify.
 *
 * The validator (and its transitive `node:crypto` dependency) is imported dynamically inside the
 * Node.js branch so it never lands in the Edge runtime bundle, which cannot load `node:crypto`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { requirePaymentCheckTokenSecret } = await import("@fakturio/shared");
    requirePaymentCheckTokenSecret();
  }
}

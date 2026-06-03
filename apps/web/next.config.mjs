/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@fakturio/ai",
    "@fakturio/db",
    "@fakturio/email",
    "@fakturio/shared",
    "@fakturio/storage",
    "@fakturio/workflows"
  ],
  serverExternalPackages: ["@prisma/client", "prisma", "@temporalio/worker"]
};

export default nextConfig;

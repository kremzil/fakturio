-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "normalizedAddress" TEXT,
ADD COLUMN     "normalizedName" TEXT;

-- AlterTable
ALTER TABLE "Debtor" ADD COLUMN     "normalizedAddress" TEXT,
ADD COLUMN     "normalizedName" TEXT;

-- CreateTable
CREATE TABLE "EmailIntakeAddress" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "provider" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailIntakeAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailIntakeAddress_address_key" ON "EmailIntakeAddress"("address");

-- CreateIndex
CREATE INDEX "EmailIntakeAddress_organizationId_idx" ON "EmailIntakeAddress"("organizationId");

-- CreateIndex
CREATE INDEX "EmailIntakeAddress_active_idx" ON "EmailIntakeAddress"("active");

-- CreateIndex
CREATE INDEX "Customer_normalizedName_idx" ON "Customer"("normalizedName");

-- CreateIndex
CREATE INDEX "Customer_normalizedName_normalizedAddress_idx" ON "Customer"("normalizedName", "normalizedAddress");

-- CreateIndex
CREATE INDEX "Customer_ico_idx" ON "Customer"("ico");

-- CreateIndex
CREATE INDEX "Customer_dic_idx" ON "Customer"("dic");

-- CreateIndex
CREATE INDEX "Customer_icDph_idx" ON "Customer"("icDph");

-- CreateIndex
CREATE INDEX "Debtor_normalizedName_idx" ON "Debtor"("normalizedName");

-- CreateIndex
CREATE INDEX "Debtor_normalizedName_normalizedAddress_idx" ON "Debtor"("normalizedName", "normalizedAddress");

-- CreateIndex
CREATE INDEX "Debtor_dic_idx" ON "Debtor"("dic");

-- CreateIndex
CREATE INDEX "Debtor_icDph_idx" ON "Debtor"("icDph");

-- AddForeignKey
ALTER TABLE "EmailIntakeAddress" ADD CONSTRAINT "EmailIntakeAddress_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

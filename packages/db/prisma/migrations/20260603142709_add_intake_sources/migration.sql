-- CreateEnum
CREATE TYPE "IntakeSource" AS ENUM ('UPLOAD', 'EMAIL');

-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "sourceType" "IntakeSource" NOT NULL DEFAULT 'UPLOAD';

-- AlterTable
ALTER TABLE "InvoiceDocument" ADD COLUMN     "communicationId" TEXT,
ADD COLUMN     "sourceType" "IntakeSource" NOT NULL DEFAULT 'UPLOAD';

-- CreateIndex
CREATE INDEX "Case_sourceType_idx" ON "Case"("sourceType");

-- CreateIndex
CREATE INDEX "InvoiceDocument_communicationId_idx" ON "InvoiceDocument"("communicationId");

-- CreateIndex
CREATE INDEX "InvoiceDocument_sourceType_idx" ON "InvoiceDocument"("sourceType");

-- AddForeignKey
ALTER TABLE "InvoiceDocument" ADD CONSTRAINT "InvoiceDocument_communicationId_fkey" FOREIGN KEY ("communicationId") REFERENCES "Communication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

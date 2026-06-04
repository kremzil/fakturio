-- AlterTable
ALTER TABLE "Communication"
ADD COLUMN "sendLeaseId" TEXT,
ADD COLUMN "sendLeaseUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Communication_sendLeaseUntil_idx" ON "Communication"("sendLeaseUntil");

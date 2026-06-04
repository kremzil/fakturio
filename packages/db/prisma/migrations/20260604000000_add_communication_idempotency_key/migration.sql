-- AlterTable
ALTER TABLE "Communication" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Communication_idempotencyKey_key" ON "Communication"("idempotencyKey");

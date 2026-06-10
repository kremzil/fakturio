ALTER TABLE "Communication"
ADD COLUMN "classificationLeaseId" TEXT,
ADD COLUMN "classificationLeaseUntil" TIMESTAMP(3);

CREATE INDEX "Communication_classificationLeaseUntil_idx"
ON "Communication"("classificationLeaseUntil");

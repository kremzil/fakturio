CREATE TABLE "WorkflowCommand" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseId" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowCommand_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkflowCommand_idempotencyKey_key" ON "WorkflowCommand"("idempotencyKey");
CREATE INDEX "WorkflowCommand_caseId_idx" ON "WorkflowCommand"("caseId");
CREATE INDEX "WorkflowCommand_organizationId_idx" ON "WorkflowCommand"("organizationId");
CREATE INDEX "WorkflowCommand_deliveredAt_availableAt_idx" ON "WorkflowCommand"("deliveredAt", "availableAt");
CREATE INDEX "WorkflowCommand_leaseUntil_idx" ON "WorkflowCommand"("leaseUntil");

ALTER TABLE "WorkflowCommand"
ADD CONSTRAINT "WorkflowCommand_caseId_fkey"
FOREIGN KEY ("caseId") REFERENCES "Case"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

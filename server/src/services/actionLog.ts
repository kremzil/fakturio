import { prisma } from "../prisma.js";

type ActionLogInput = {
  invoiceId?: string | null;
  uploadId?: string | null;
  actorType?: string;
  actorId?: string | null;
  action: string;
  note?: string | null;
};

export async function createActionLog(input: ActionLogInput) {
  await prisma.invoiceActionLog.create({
    data: {
      invoiceId: input.invoiceId ?? null,
      uploadId: input.uploadId ?? null,
      actorType: input.actorType ?? "system",
      actorId: input.actorId ?? null,
      action: input.action,
      note: input.note ?? null
    }
  });
}

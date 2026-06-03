import { NextResponse } from "next/server";
import { CASE_EVENT_TYPES, parseIsoDate, validateInvoiceForWorkflow } from "@fakturio/shared";
import { createAiProvider } from "@fakturio/ai";
import { ensureLocalBootstrap, prisma } from "@fakturio/db";
import { createStorageProvider } from "@fakturio/storage";
import { toDashboardCase } from "@/lib/case-data";

export const runtime = "nodejs";

const ACCEPTED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Chýba súbor faktúry." }, { status: 400 });
    }

    if (!ACCEPTED_TYPES.has(file.type)) {
      return NextResponse.json({ error: "Podporované sú PDF, JPG, PNG alebo WEBP faktúry." }, { status: 415 });
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "Maximálna veľkosť súboru je 20 MB." }, { status: 413 });
    }

    const { organization, user } = await ensureLocalBootstrap();
    const bytes = new Uint8Array(await file.arrayBuffer());

    const collectionCase = await prisma.case.create({
      data: {
        organizationId: organization.id,
        status: "RECEIVED",
        events: {
          create: {
            actorType: "USER",
            actorId: user.id,
            type: CASE_EVENT_TYPES.caseCreated,
            note: `Uploaded ${file.name}.`
          }
        }
      }
    });

    const storage = createStorageProvider();
    const stored = await storage.putObject({
      organizationId: organization.id,
      caseId: collectionCase.id,
      fileName: file.name,
      contentType: file.type,
      body: bytes
    });

    await prisma.invoiceDocument.create({
      data: {
        caseId: collectionCase.id,
        storageBucket: stored.bucket,
        storageKey: stored.key,
        originalName: file.name,
        mimeType: file.type,
        sizeBytes: stored.sizeBytes
      }
    });

    try {
      const ai = createAiProvider();
      const parsed = await ai.extractInvoice({
        fileName: file.name,
        mimeType: file.type,
        bytes
      });

      const debtor = parsed.debtor.name
        ? await prisma.debtor.create({
            data: {
              organizationId: organization.id,
              name: parsed.debtor.name,
              email: parsed.debtor.email,
              ico: parsed.debtor.ico,
              dic: parsed.debtor.dic,
              icDph: parsed.debtor.icDph,
              address: parsed.debtor.address
            }
          })
        : null;

      const customer = parsed.supplier.name
        ? await prisma.customer.create({
            data: {
              organizationId: organization.id,
              name: parsed.supplier.name,
              email: parsed.supplier.email,
              ico: parsed.supplier.ico,
              dic: parsed.supplier.dic,
              icDph: parsed.supplier.icDph,
              address: parsed.supplier.address
            }
          })
        : null;

      const validation = validateInvoiceForWorkflow({
        invoiceNumber: parsed.invoiceNumber,
        dueDate: parsed.dueDate,
        amountTotal: parsed.amountTotal,
        debtorName: parsed.debtor.name,
        currency: parsed.currency,
        warnings: parsed.warnings
      });
      const warnings = validation.warningsPatch ?? parsed.warnings;
      const status = parsed.manualReviewRequired || validation.errors.length > 0 ? "MANUAL_REVIEW_REQUIRED" : "PARSED";

      const updated = await prisma.case.update({
        where: { id: collectionCase.id },
        data: {
          status,
          customerId: customer?.id,
          debtorId: debtor?.id,
          invoiceNumber: parsed.invoiceNumber,
          issueDate: parseIsoDate(parsed.issueDate),
          dueDate: parseIsoDate(parsed.dueDate),
          amountTotal: parsed.amountTotal,
          currency: parsed.currency ?? validation.currencyPatch,
          supplierSnapshot: parsed.supplier,
          debtorSnapshot: parsed.debtor,
          paymentSnapshot: parsed.payment,
          subjectNote: parsed.subjectNote,
          aiConfidence: parsed.confidence,
          warnings,
          rawAiResult: toJsonValue(parsed.rawResult),
          events: {
            create: {
              actorType: "AI",
              type: status === "PARSED" ? CASE_EVENT_TYPES.invoiceParsed : CASE_EVENT_TYPES.manualReviewRequired,
              note: status === "PARSED" ? "OpenAI extraction completed." : validation.errors.join(" ") || "Manual review required."
            }
          }
        },
        include: {
          debtor: true,
          invoiceDocuments: { orderBy: { createdAt: "desc" }, take: 1 },
          events: { orderBy: { createdAt: "desc" }, take: 6 }
        }
      });

      return NextResponse.json({ case: toDashboardCase(updated), parseError: null }, { status: 201 });
    } catch (error) {
      const updated = await prisma.case.update({
        where: { id: collectionCase.id },
        data: {
          status: "MANUAL_REVIEW_REQUIRED",
          warnings: ["Automatické načítanie zlyhalo. Doplňte údaje manuálne."],
          events: {
            create: {
              actorType: "AI",
              type: CASE_EVENT_TYPES.manualReviewRequired,
              note: error instanceof Error ? error.message : "AI parse failed."
            }
          }
        },
        include: {
          debtor: true,
          invoiceDocuments: { orderBy: { createdAt: "desc" }, take: 1 },
          events: { orderBy: { createdAt: "desc" }, take: 6 }
        }
      });

      return NextResponse.json(
        { case: toDashboardCase(updated), parseError: error instanceof Error ? error.message : "AI parse failed." },
        { status: 201 }
      );
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Nahratie faktúry zlyhalo." },
      { status: 500 }
    );
  }
}

function toJsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

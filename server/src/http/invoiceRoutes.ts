import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import multer from "multer";
import { prisma } from "../prisma.js";
import { ACTIONS, LOCAL_USER_ID } from "../domain/statuses.js";
import {
  cleanText,
  invoicePatchSchema,
  parseIsoDate,
  serializeWarnings,
  validateForConfirmation
} from "../domain/validators.js";
import { ParsedInvoiceResult, emptyParsedInvoiceData } from "../domain/parsedInvoice.js";
import { createActionLog } from "../services/actionLog.js";
import { InvoiceParsingService } from "../services/invoiceParsingService.js";
import { HttpError, toErrorMessage } from "./errors.js";
import { mapInvoice } from "./invoiceMapper.js";

const uploadDir = path.resolve(process.cwd(), "storage", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const acceptedMimeTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const acceptedExtensions = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp"]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (acceptedMimeTypes.has(file.mimetype) && acceptedExtensions.has(ext)) {
      cb(null, true);
      return;
    }

    cb(new HttpError(415, "Podporované sú iba PDF, JPG, PNG a WEBP súbory."));
  }
});

export function createInvoiceRouter(parsingService = new InvoiceParsingService()) {
  const router = Router();

  router.get("/invoices", async (_req, res, next) => {
    try {
      const invoices = await prisma.invoice.findMany({
        include: { upload: true },
        orderBy: { createdAt: "desc" }
      });

      res.json({ invoices: invoices.map(mapInvoice) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/invoice-uploads", (req, res, next) => {
    upload.single("file")(req, res, (error) => {
      if (error) {
        next(error);
        return;
      }

      void handleInvoiceUpload(req, res, next, parsingService);
    });
  });

  router.get("/invoice-uploads/:id/file", async (req, res, next) => {
    try {
      const uploadRecord = await prisma.invoiceUpload.findUnique({ where: { id: req.params.id } });
      if (!uploadRecord) {
        throw new HttpError(404, "Súbor nebol nájdený.");
      }

      res.type(uploadRecord.fileType);
      res.sendFile(path.resolve(uploadRecord.filePath));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/invoices/:id", express.json(), async (req, res, next) => {
    try {
      const patch = invoicePatchSchema.parse(req.body);
      const update = buildInvoicePatch(patch);

      const invoice = await prisma.invoice.update({
        where: { id: req.params.id },
        data: update,
        include: { upload: true }
      });

      await createActionLog({
        invoiceId: invoice.id,
        uploadId: invoice.uploadId,
        actorType: "user",
        actorId: LOCAL_USER_ID,
        action: ACTIONS.userEditedField,
        note: Object.keys(update).join(", ")
      });

      res.json({ invoice: mapInvoice(invoice) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/invoices/:id/confirm", express.json(), async (req, res, next) => {
    try {
      const patch = invoicePatchSchema.parse(req.body ?? {});
      const patchData = buildInvoicePatch(patch);

      const invoice = await prisma.invoice.update({
        where: { id: req.params.id },
        data: patchData,
        include: { upload: true }
      });

      const validation = validateForConfirmation(invoice);
      if (validation.errors.length > 0) {
        res.status(400).json({ errors: validation.errors, invoice: mapInvoice(invoice) });
        return;
      }

      const confirmed = await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          currency: validation.currencyPatch ?? invoice.currency,
          warnings: validation.warningsPatch ?? invoice.warnings,
          confirmedByUser: LOCAL_USER_ID,
          confirmedAt: new Date(),
          upload: {
            update: {
              status: "REGISTERED",
              parseError: null
            }
          }
        },
        include: { upload: true }
      });

      await createActionLog({
        invoiceId: confirmed.id,
        uploadId: confirmed.uploadId,
        actorType: "user",
        actorId: LOCAL_USER_ID,
        action: ACTIONS.userConfirmed
      });
      await createActionLog({
        invoiceId: confirmed.id,
        uploadId: confirmed.uploadId,
        actorType: "system",
        action: ACTIONS.invoiceRegistered
      });

      res.json({ invoice: mapInvoice(confirmed) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/invoice-uploads/:id/cancel", express.json(), async (req, res, next) => {
    try {
      const uploadRecord = await prisma.invoiceUpload.update({
        where: { id: req.params.id },
        data: { status: "CANCELLED" },
        include: { invoice: { include: { upload: true } } }
      });

      await createActionLog({
        invoiceId: uploadRecord.invoice?.id,
        uploadId: uploadRecord.id,
        actorType: "user",
        actorId: LOCAL_USER_ID,
        action: ACTIONS.uploadCancelled
      });

      res.json({
        upload: {
          id: uploadRecord.id,
          status: uploadRecord.status
        },
        invoice: uploadRecord.invoice ? mapInvoice(uploadRecord.invoice) : null
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

async function handleInvoiceUpload(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
  parsingService: InvoiceParsingService
) {
  try {
    const file = req.file;
    if (!file) {
      throw new HttpError(400, "Súbor je povinný.");
    }

    const uploadRecord = await prisma.invoiceUpload.create({
      data: {
        userId: LOCAL_USER_ID,
        filePath: file.path,
        fileName: file.originalname,
        fileType: file.mimetype,
        fileSize: file.size,
        status: "UPLOADED"
      }
    });

    await createActionLog({
      uploadId: uploadRecord.id,
      actorType: "user",
      actorId: LOCAL_USER_ID,
      action: ACTIONS.uploadCreated
    });

    await prisma.invoiceUpload.update({
      where: { id: uploadRecord.id },
      data: { status: "PARSING" }
    });
    await createActionLog({
      uploadId: uploadRecord.id,
      actorType: "system",
      action: ACTIONS.aiParseStarted
    });

    try {
      const parsed = await parsingService.parseInvoice({
        path: file.path,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size
      });

      await prisma.invoiceUpload.update({
        where: { id: uploadRecord.id },
        data: { status: "PARSED" }
      });

      const invoice = await createInvoiceFromParsed(uploadRecord.id, parsed);
      const needsReview = await prisma.invoiceUpload.update({
        where: { id: uploadRecord.id },
        data: { status: "NEEDS_REVIEW", parseError: null }
      });

      await createActionLog({
        invoiceId: invoice.id,
        uploadId: uploadRecord.id,
        actorType: "system",
        action: ACTIONS.aiParseCompleted
      });

      res.status(201).json({
        invoice: mapInvoice({ ...invoice, upload: needsReview }),
        parseError: null
      });
    } catch (parseError) {
      const errorMessage = toErrorMessage(parseError);
      const failedUpload = await prisma.invoiceUpload.update({
        where: { id: uploadRecord.id },
        data: { status: "PARSE_FAILED", parseError: errorMessage }
      });
      const invoice = await createInvoiceFromParseFailure(uploadRecord.id, errorMessage);

      await createActionLog({
        invoiceId: invoice.id,
        uploadId: uploadRecord.id,
        actorType: "system",
        action: ACTIONS.aiParseFailed,
        note: errorMessage
      });

      res.status(201).json({
        invoice: mapInvoice({ ...invoice, upload: failedUpload }),
        parseError: errorMessage
      });
    }
  } catch (error) {
    next(error);
  }
}

async function createInvoiceFromParsed(uploadId: string, parsed: ParsedInvoiceResult) {
  return prisma.invoice.create({
    data: {
      uploadId,
      userId: LOCAL_USER_ID,
      invoiceNumber: cleanText(parsed.invoiceNumber),
      issueDate: parseIsoDate(parsed.issueDate),
      dueDate: parseIsoDate(parsed.dueDate),
      amountTotal: parsed.amountTotal,
      currency: cleanText(parsed.currency),
      supplierName: cleanText(parsed.supplier.name),
      supplierIco: cleanText(parsed.supplier.ico),
      supplierDic: cleanText(parsed.supplier.dic),
      supplierIcDph: cleanText(parsed.supplier.icDph),
      supplierAddress: cleanText(parsed.supplier.address),
      debtorName: cleanText(parsed.debtor.name),
      debtorIco: cleanText(parsed.debtor.ico),
      debtorDic: cleanText(parsed.debtor.dic),
      debtorIcDph: cleanText(parsed.debtor.icDph),
      debtorAddress: cleanText(parsed.debtor.address),
      iban: cleanText(parsed.payment.iban),
      variableSymbol: cleanText(parsed.payment.variableSymbol),
      constantSymbol: cleanText(parsed.payment.constantSymbol),
      specificSymbol: cleanText(parsed.payment.specificSymbol),
      subjectNote: cleanText(parsed.subjectNote),
      rawAiResult: JSON.stringify(parsed.rawResult),
      aiConfidence: parsed.confidence,
      warnings: serializeWarnings(parsed.warnings)
    }
  });
}

async function createInvoiceFromParseFailure(uploadId: string, errorMessage: string) {
  const empty = emptyParsedInvoiceData();
  return prisma.invoice.create({
    data: {
      uploadId,
      userId: LOCAL_USER_ID,
      rawAiResult: JSON.stringify({ error: errorMessage }),
      aiConfidence: empty.confidence,
      warnings: serializeWarnings(["Automatické načítanie zlyhalo. Doplňte údaje manuálne."])
    }
  });
}

function buildInvoicePatch(patch: ReturnType<typeof invoicePatchSchema.parse>) {
  return {
    invoiceNumber: "invoiceNumber" in patch ? cleanText(patch.invoiceNumber) : undefined,
    issueDate: "issueDate" in patch ? parseIsoDate(patch.issueDate) : undefined,
    dueDate: "dueDate" in patch ? parseIsoDate(patch.dueDate) : undefined,
    amountTotal: "amountTotal" in patch ? patch.amountTotal : undefined,
    currency: "currency" in patch ? cleanText(patch.currency) : undefined,
    supplierName: "supplierName" in patch ? cleanText(patch.supplierName) : undefined,
    supplierIco: "supplierIco" in patch ? cleanText(patch.supplierIco) : undefined,
    supplierDic: "supplierDic" in patch ? cleanText(patch.supplierDic) : undefined,
    supplierIcDph: "supplierIcDph" in patch ? cleanText(patch.supplierIcDph) : undefined,
    supplierAddress: "supplierAddress" in patch ? cleanText(patch.supplierAddress) : undefined,
    debtorName: "debtorName" in patch ? cleanText(patch.debtorName) : undefined,
    debtorIco: "debtorIco" in patch ? cleanText(patch.debtorIco) : undefined,
    debtorDic: "debtorDic" in patch ? cleanText(patch.debtorDic) : undefined,
    debtorIcDph: "debtorIcDph" in patch ? cleanText(patch.debtorIcDph) : undefined,
    debtorAddress: "debtorAddress" in patch ? cleanText(patch.debtorAddress) : undefined,
    iban: "iban" in patch ? cleanText(patch.iban) : undefined,
    variableSymbol: "variableSymbol" in patch ? cleanText(patch.variableSymbol) : undefined,
    constantSymbol: "constantSymbol" in patch ? cleanText(patch.constantSymbol) : undefined,
    specificSymbol: "specificSymbol" in patch ? cleanText(patch.specificSymbol) : undefined,
    subjectNote: "subjectNote" in patch ? cleanText(patch.subjectNote) : undefined
  };
}

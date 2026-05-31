// @vitest-environment node
import { execSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { createApp as CreateApp } from "../server/src/app";
import type { InvoiceParsingService } from "../server/src/services/invoiceParsingService";
import type { ParsedInvoiceResult } from "../server/src/domain/parsedInvoice";

let createApp: typeof CreateApp;
let prisma: PrismaClient;

const parsedResult: ParsedInvoiceResult = {
  invoiceNumber: "FV-2026-00124",
  issueDate: "2026-05-20",
  dueDate: "2026-06-03",
  amountTotal: 480,
  currency: "EUR",
  supplier: {
    name: "ABC s.r.o.",
    ico: "12345678",
    dic: "2020123456",
    icDph: "SK2020123456",
    address: "Hlavná 12, 811 01 Bratislava"
  },
  debtor: {
    name: "XYZ s.r.o.",
    ico: "87654321",
    dic: "2020654321",
    icDph: "SK2020654321",
    address: "Dlhá 4, 040 01 Košice"
  },
  payment: {
    iban: "SK1211000000002941987654",
    variableSymbol: "202600124",
    constantSymbol: null,
    specificSymbol: null
  },
  subjectNote: "Dodanie služieb podľa objednávky.",
  confidence: 0.86,
  warnings: ["Skontrolujte IBAN."],
  rawResult: { fixture: true }
};

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "file:./test.db";
  process.env.MOCK_AI = "0";

  execSync("npx prisma db execute --file prisma/init.sql --schema prisma/schema.prisma", {
    cwd: process.cwd(),
    env: process.env,
    stdio: "pipe"
  });

  ({ createApp } = await import("../server/src/app"));
  ({ prisma } = await import("../server/src/prisma"));
});

beforeEach(async () => {
  await prisma.invoiceActionLog.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.invoiceUpload.deleteMany();
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("invoice API", () => {
  it("uploads a PDF, stores raw AI result, and confirms the invoice", async () => {
    const parsingService = {
      parseInvoice: vi.fn(async () => parsedResult)
    } as unknown as InvoiceParsingService;
    const app = createApp({ parsingService });

    const uploadResponse = await request(app)
      .post("/api/invoice-uploads")
      .attach("file", Buffer.from("%PDF-1.4 faktura"), {
        filename: "faktura.pdf",
        contentType: "application/pdf"
      })
      .expect(201);

    expect(uploadResponse.body.invoice.upload.status).toBe("NEEDS_REVIEW");
    expect(uploadResponse.body.invoice.invoiceNumber).toBe("FV-2026-00124");

    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: uploadResponse.body.invoice.id } });
    expect(stored.rawAiResult).toContain("fixture");

    const confirmResponse = await request(app)
      .post(`/api/invoices/${uploadResponse.body.invoice.id}/confirm`)
      .send({})
      .expect(200);

    expect(confirmResponse.body.invoice.upload.status).toBe("REGISTERED");
    expect(confirmResponse.body.invoice.confirmedByUser).toBe("local-user");
  });

  it("rejects unsupported file types", async () => {
    const app = createApp({
      parsingService: { parseInvoice: vi.fn() } as unknown as InvoiceParsingService
    });

    const response = await request(app)
      .post("/api/invoice-uploads")
      .attach("file", Buffer.from("hello"), {
        filename: "notes.txt",
        contentType: "text/plain"
      })
      .expect(415);

    expect(response.body.error).toContain("PDF");
  });

  it("creates a manual draft when parsing fails", async () => {
    const app = createApp({
      parsingService: {
        parseInvoice: vi.fn(async () => {
          throw new Error("OCR failed");
        })
      } as unknown as InvoiceParsingService
    });

    const uploadResponse = await request(app)
      .post("/api/invoice-uploads")
      .attach("file", Buffer.from("%PDF-1.4 faktura"), {
        filename: "broken.pdf",
        contentType: "application/pdf"
      })
      .expect(201);

    expect(uploadResponse.body.invoice.upload.status).toBe("PARSE_FAILED");
    expect(uploadResponse.body.invoice.warnings[0]).toContain("manuálne");

    const confirmResponse = await request(app)
      .post(`/api/invoices/${uploadResponse.body.invoice.id}/confirm`)
      .send({
        invoiceNumber: "MAN-1",
        dueDate: "2026-06-03",
        amountTotal: 50,
        debtorName: "Manual s.r.o.",
        currency: null
      })
      .expect(200);

    expect(confirmResponse.body.invoice.upload.status).toBe("REGISTERED");
    expect(confirmResponse.body.invoice.currency).toBe("EUR");
    expect(confirmResponse.body.invoice.warnings.join(" ")).toContain("Mena nebola rozpoznaná");
  });
});

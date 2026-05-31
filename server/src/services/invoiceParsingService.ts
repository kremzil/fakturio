import { readFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { env } from "../env.js";
import {
  ParsedInvoiceResult,
  emptyParsedInvoiceData,
  parsedInvoiceDataSchema
} from "../domain/parsedInvoice.js";

export type UploadedInvoiceFile = {
  path: string;
  originalName: string;
  mimeType: string;
  size: number;
};

export class InvoiceParsingService {
  private readonly client: OpenAI | null;

  constructor(client?: OpenAI) {
    this.client = client ?? (env.openAiApiKey ? new OpenAI({ apiKey: env.openAiApiKey }) : null);
  }

  async parseInvoice(file: UploadedInvoiceFile): Promise<ParsedInvoiceResult> {
    if (env.mockAi) {
      return this.parseWithMock(file);
    }

    if (!this.client) {
      throw new Error("OPENAI_API_KEY is missing. Set MOCK_AI=1 for local mock parsing or provide an API key.");
    }

    const base64 = await readFile(file.path, "base64");
    const filePart =
      file.mimeType === "application/pdf"
        ? {
            type: "input_file" as const,
            filename: file.originalName,
            file_data: base64
          }
        : {
            type: "input_image" as const,
            image_url: `data:${file.mimeType};base64,${base64}`,
            detail: "high" as const
          };

    const response = await this.client.responses.parse({
      model: env.openAiModel,
      store: false,
      temperature: 0,
      input: [
        {
          role: "system",
          content:
            "You extract invoice data for a Slovak invoice-control app. Return null for fields that are not visible. Do not guess. Dates must be ISO YYYY-MM-DD. Currency must be ISO 4217. Amounts must be numeric with decimal point."
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Extract structured invoice data from this faktúra. Focus on invoice number, issue date, due date / splatnosť, amount due, currency, supplier, debtor / odberateľ, IČO, DIČ, IČ DPH, IBAN, variabilný symbol and predmet / poznámka."
            },
            filePart
          ]
        }
      ],
      text: {
        format: zodTextFormat(parsedInvoiceDataSchema, "parsed_invoice")
      }
    });

    const parsed = extractParsedResponse(response);
    if (!parsed) {
      throw new Error("OpenAI response did not contain parsed invoice data.");
    }

    return {
      ...parsed,
      rawResult: response
    };
  }

  private parseWithMock(file: UploadedInvoiceFile): ParsedInvoiceResult {
    const stem = path.parse(file.originalName).name.replace(/[^\dA-Za-z-]/g, "").slice(0, 18);
    const data = emptyParsedInvoiceData();

    return {
      ...data,
      invoiceNumber: stem ? `FV-${stem}` : "FV-2026-00124",
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
      warnings: ["MOCK_AI režim: údaje sú ukážkové a treba ich skontrolovať."],
      rawResult: {
        mock: true,
        fileName: file.originalName,
        fileType: file.mimeType,
        fileSize: file.size
      }
    };
  }
}

function extractParsedResponse(response: unknown) {
  const candidate = response as {
    output_parsed?: unknown;
    output?: Array<{ type?: string; content?: Array<{ parsed?: unknown; type?: string }> }>;
  };

  const direct = parsedInvoiceDataSchema.safeParse(candidate.output_parsed);
  if (direct.success) {
    return direct.data;
  }

  for (const output of candidate.output ?? []) {
    if (output.type !== "message") {
      continue;
    }

    for (const item of output.content ?? []) {
      const parsed = parsedInvoiceDataSchema.safeParse(item.parsed);
      if (parsed.success) {
        return parsed.data;
      }
    }
  }

  return null;
}

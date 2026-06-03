import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  AiProvider,
  CaseSummaryInput,
  DebtorReplyInput,
  GenerateEmailInput,
  InvoiceExtractionInput,
  debtorReplyClassificationSchema,
  invoiceExtractionResultSchema
} from "@fakturio/shared";
import { buildInvoiceFileInput } from "./input";

export type OpenAiProviderOptions = {
  apiKey: string;
  model?: string;
  client?: OpenAI;
};

export class OpenAiProvider implements AiProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAiProviderOptions) {
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey });
    this.model = options.model ?? "gpt-4.1";
  }

  async extractInvoice(input: InvoiceExtractionInput) {
    const filePart = buildInvoiceFileInput({
      fileName: input.fileName,
      mimeType: input.mimeType,
      base64: Buffer.from(input.bytes).toString("base64")
    });

    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      temperature: 0,
      input: [
        {
          role: "system",
          content:
            "You extract invoice data for a Slovak autonomous soft-collection system. Return null for fields that are not visible. Do not guess. Dates must be ISO YYYY-MM-DD. Currency must be ISO 4217. Amounts must be numeric with decimal point. Set manualReviewRequired when key fields are missing or confidence is low."
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Extract structured invoice data from this faktúra. Focus on invoice number, issue date, due date / splatnosť, amount due, currency, supplier, debtor / odberateľ, debtor email if visible, IČO, DIČ, IČ DPH, IBAN, variabilný symbol and predmet / poznámka.\n\nEmail body context:\n${input.emailBody ?? "(none)"}`
            },
            filePart
          ]
        }
      ],
      text: {
        format: zodTextFormat(invoiceExtractionResultSchema, "invoice_extraction")
      }
    });

    const parsed = extractParsedResponse(response, invoiceExtractionResultSchema.safeParse.bind(invoiceExtractionResultSchema));
    if (!parsed) {
      throw new Error("OpenAI response did not contain parsed invoice data.");
    }

    return {
      ...parsed,
      rawResult: response
    };
  }

  async classifyDebtorReply(input: DebtorReplyInput) {
    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      temperature: 0,
      input: [
        {
          role: "system",
          content:
            "Classify debtor replies for a Slovak soft-collection workflow. Never approve discounts, legal action, or non-standard terms. Return structured classification only."
        },
        {
          role: "user",
          content: `Case summary:\n${input.latestCaseSummary ?? "(none)"}\n\nDebtor reply:\n${input.messageText}`
        }
      ],
      text: {
        format: zodTextFormat(debtorReplyClassificationSchema, "debtor_reply_classification")
      }
    });

    const parsed = extractParsedResponse(
      response,
      debtorReplyClassificationSchema.safeParse.bind(debtorReplyClassificationSchema)
    );
    if (!parsed) {
      throw new Error("OpenAI response did not contain debtor reply classification.");
    }

    return parsed;
  }

  async generateDebtorEmail(input: GenerateEmailInput) {
    const subject = `Pripomienka úhrady faktúry ${input.invoiceNumber}`;
    const textBody = `Dobrý deň ${input.debtorName},\n\n evidujeme neuhradenú faktúru ${input.invoiceNumber} vo výške ${input.amountTotal} ${input.currency}, splatnú ${input.dueDate}. Prosíme o úhradu alebo odpoveď s informáciou o stave platby.\n\nĎakujeme.`;

    return {
      subject,
      textBody,
      htmlBody: `<p>${textBody.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br />")}</p>`,
      warnings: ["Email generation is template-based in the bootstrap implementation."]
    };
  }

  async summarizeCase(input: CaseSummaryInput) {
    return {
      summary: input.events.join("\n").slice(0, 1400),
      riskLevel: "MEDIUM" as const,
      recommendedNextAction: "Continue according to the configured collection workflow."
    };
  }
}

function extractParsedResponse<T>(
  response: unknown,
  parse: (value: unknown) => { success: true; data: T } | { success: false }
): T | null {
  const candidate = response as {
    output_parsed?: unknown;
    output?: Array<{ type?: string; content?: Array<{ parsed?: unknown; type?: string }> }>;
  };

  const direct = parse(candidate.output_parsed);
  if (direct.success) {
    return direct.data;
  }

  for (const output of candidate.output ?? []) {
    if (output.type !== "message") {
      continue;
    }

    for (const item of output.content ?? []) {
      const parsed = parse(item.parsed);
      if (parsed.success) {
        return parsed.data;
      }
    }
  }

  return null;
}

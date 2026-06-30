import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  AiProvider,
  CaseSummaryInput,
  CustomerMessageInput,
  DebtorReplyInput,
  GenerateEmailInput,
  InvoiceEmailAttachmentTriageInput,
  InvoiceExtractionInput,
  customerMessageClassificationSchema,
  debtorReplyClassificationSchema,
  invoiceEmailAttachmentTriageResultSchema,
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

  async classifyInvoiceEmailAttachments(input: InvoiceEmailAttachmentTriageInput) {
    const content = [
      {
        type: "input_text" as const,
        text: [
          "Classify this inbound customer email attachment set before invoice intake.",
          "Decide whether the supported attachments are separate invoices, one invoice with supporting documents, or too ambiguous and requiring customer clarification.",
          "Use SEPARATE_INVOICES only when each primary invoice is clearly a different invoice.",
          "Use SINGLE_INVOICE_WITH_SUPPORTING_DOCUMENTS only when exactly one primary invoice is clear and other files are supporting documents for that same case.",
          "Use NEEDS_CUSTOMER_CLARIFICATION when uncertain. Do not guess.",
          "",
          `Subject:\n${input.subject ?? "(none)"}`,
          `Email body:\n${input.messageText ?? "(none)"}`,
          `Attachment refs:\n${JSON.stringify(input.attachments.map(({ bytes, ...attachment }) => attachment), null, 2)}`
        ].join("\n")
      },
      ...input.attachments.flatMap((attachment) => [
        {
          type: "input_text" as const,
          text: `Attachment index ${attachment.index}: ${attachment.fileName} (${attachment.mimeType})`
        },
        buildInvoiceFileInput({
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          base64: Buffer.from(attachment.bytes).toString("base64")
        })
      ])
    ];

    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      temperature: 0,
      input: [
        {
          role: "system",
          content:
            "You classify sets of invoice-related email attachments for a Slovak B2B invoice collection system. Return structured output only. Never create invoice data or amounts. Only classify how attachments should be routed."
        },
        {
          role: "user",
          content
        }
      ],
      text: {
        format: zodTextFormat(
          invoiceEmailAttachmentTriageResultSchema,
          "invoice_email_attachment_triage"
        )
      }
    });

    const parsed = extractParsedResponse(
      response,
      invoiceEmailAttachmentTriageResultSchema.safeParse.bind(
        invoiceEmailAttachmentTriageResultSchema
      )
    );
    if (!parsed) {
      throw new Error("OpenAI response did not contain attachment triage data.");
    }

    return parsed;
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
            "Classify debtor replies for a Slovak soft-collection workflow. Distinguish payment claims, concrete payment promises, disputes, installment requests, explicit acceptance or rejection of a previously proposed installment schedule, automated replies, and unclear messages. explicitInstallmentAcceptance may be true only when the debtor unambiguously accepts all proposed dates and amounts shown in the case summary. Extract a mentioned payment amount only when explicit. Never approve discounts, legal action, or non-standard terms. Return structured classification only."
        },
        {
          role: "user",
          content: `Case summary and any proposed installment schedule:\n${input.latestCaseSummary ?? "(none)"}\n\nDebtor reply:\n${input.messageText}`
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

  async classifyCustomerMessage(input: CustomerMessageInput) {
    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      temperature: 0,
      input: [
        {
          role: "system",
          content:
            "Classify messages from a FAKTURIO customer account user in Slovak, Czech, English or Russian. The customer may clarify invoice fields, add a note, ask for case status/history, update missing debtor contact details, confirm/start a reviewed invoice case, approve the predefined standard installment plan, request a custom installment proposal, or ask to send an additional message to the debtor. Map phrases like 'spusti pripad', 'potvrdzujem fakturu', 'start case', 'запусти дело' to REQUEST_CONFIRM_INVOICE. Map phrases like 'standardne splatky', 'suma/3', 'standard installment plan', 'стандартная рассрочка' to REQUEST_STANDARD_INSTALLMENT_PLAN only when the customer asks to use the predefined standard three-payment plan. Map explicit non-standard payment schedule instructions to REQUEST_CUSTOM_INSTALLMENT_PLAN. Map 'napíšte dlžníkovi...', 'pošlite mu...', 'send debtor...' to REQUEST_SEND_DEBTOR_MESSAGE and put the exact debtor-facing draft in replyDraft when possible. Extract only explicit facts. Do not invent invoice values. Never approve legal action, discounts, debt amount changes, payment receipt, cancellation, pause or resume. Mark legal threats, discounts, debt amount reductions, contradictory, or low-certainty requests as needsHumanReview. Return structured classification only."
        },
        {
          role: "user",
          content: [
            `Subject:\n${input.subject ?? "(none)"}`,
            `Candidate cases:\n${JSON.stringify(input.candidateCases ?? [], null, 2)}`,
            `Current case summary:\n${input.latestCaseSummary ?? "(none)"}`,
            `Customer message:\n${input.messageText}`
          ].join("\n\n")
        }
      ],
      text: {
        format: zodTextFormat(
          customerMessageClassificationSchema,
          "customer_message_classification"
        )
      }
    });

    const parsed = extractParsedResponse(
      response,
      customerMessageClassificationSchema.safeParse.bind(customerMessageClassificationSchema)
    );
    if (!parsed) {
      throw new Error("OpenAI response did not contain customer message classification.");
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

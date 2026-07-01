import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  AiProvider,
  CaseSummaryInput,
  CustomerDecisionEmailInput,
  CustomerMessageInput,
  DashboardCaseAssistantInput,
  DebtorReplyInput,
  GenerateEmailInput,
  InvoiceEmailAttachmentTriageInput,
  InvoiceExtractionInput,
  customerMessageClassificationSchema,
  customerDecisionEmailDraftSchema,
  dashboardCaseAssistantReplySchema,
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
            "Classify debtor replies for a Slovak soft-collection workflow. Distinguish payment claims, concrete payment promises, disputes, installment requests, explicit acceptance or rejection of a previously proposed installment schedule, automated replies, and unclear messages. explicitInstallmentAcceptance may be true only when the debtor unambiguously accepts all proposed dates and amounts shown in the case summary. Extract a mentioned payment amount only when explicit. If the debtor asks for a concrete number of installments, set requestedInstallmentCount. Never approve discounts, legal action, or non-standard terms. Return structured classification only."
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
            "Classify messages from a FAKTURIO customer account user in Slovak, Czech, English or Russian. The customer may clarify invoice fields, add a note, ask for case status/history, update missing debtor contact details, confirm/start a reviewed invoice case, approve the predefined standard installment plan, request a custom installment proposal, ask to send an additional message to the debtor, or request the approved final notice before legal review. Map phrases like 'spusti pripad', 'potvrdzujem fakturu', 'start case', 'запусти дело' to REQUEST_CONFIRM_INVOICE. Map phrases like 'standardne splatky', 'suma/3', 'standard installment plan', 'стандартная рассрочка' to REQUEST_STANDARD_INSTALLMENT_PLAN only when the customer asks to use the predefined standard three-payment plan. Map explicit non-standard payment schedule instructions to REQUEST_CUSTOM_INSTALLMENT_PLAN. For custom installment plans, fill requestedInstallmentPlan: paymentCount when the user asks for a number of payments, firstPaymentAmount when the first payment amount is explicit, paymentAmounts/dueDates only when every amount/date is explicitly provided. Map 'napíšte dlžníkovi...', 'pošlite mu...', 'send debtor...' to REQUEST_SEND_DEBTOR_MESSAGE and put the exact debtor-facing draft in replyDraft when possible. Map requests to send an approved final/pre-legal notice, reserve rights to court recovery, ask whether refusal to pay is final, or move toward legal review to REQUEST_FINAL_NOTICE. Extract only explicit facts. Do not invent invoice values. Never approve discounts, debt amount changes, payment receipt, cancellation, pause or resume. Mark arbitrary legal threats, discounts, debt amount reductions, contradictory, or low-certainty requests as needsHumanReview. The approved final notice request is not arbitrary legal drafting; classify it as REQUEST_FINAL_NOTICE. Return structured classification only."
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

  async answerDashboardCaseMessage(input: DashboardCaseAssistantInput) {
    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      temperature: 0.2,
      input: [
        {
          role: "system",
          content:
            "You are the FAKTURIO dashboard case assistant for an authenticated customer user. Answer conversationally in the user's language. Use only the supplied case snapshot, recent events, and recent communications; do not invent facts. Do not expose raw internal status codes, payload JSON, implementation details, or English audit notes. Translate statuses and events into plain language. If the user asks what happened, explain the chronological story. If the user asks why attention is needed, explain the concrete blocker, especially automation pause reason and latest debtor reply. If the debtor replied, summarize the latest debtor inbound message and include only a short necessary excerpt. If the user asks what to do next, give practical options based on allowedActions. Guardrails: never change debt amount, approve discounts, accept non-standard legal terms, file legal action, or draft arbitrary legal threats. You may mention that the system can send only an approved final notice template, propose the standard installment plan, send a neutral debtor message, pause/resume, mark paid, or cancel when allowed. If an action is not possible, say why and where the user can handle it manually. Return structured output only."
        },
        {
          role: "user",
          content: [
            `User language: ${input.userLanguage}`,
            `User message:\n${input.userMessage}`,
            `Case snapshot:\n${JSON.stringify(input.caseSnapshot, null, 2)}`,
            `Allowed actions:\n${input.allowedActions.join(", ") || "(none)"}`,
            `Recent events:\n${JSON.stringify(input.recentEvents, null, 2)}`,
            `Recent communications:\n${JSON.stringify(input.recentCommunications, null, 2)}`
          ].join("\n\n")
        }
      ],
      text: {
        format: zodTextFormat(
          dashboardCaseAssistantReplySchema,
          "dashboard_case_assistant_reply"
        )
      }
    });

    const parsed = extractParsedResponse(
      response,
      dashboardCaseAssistantReplySchema.safeParse.bind(dashboardCaseAssistantReplySchema)
    );
    if (!parsed) {
      throw new Error("OpenAI response did not contain dashboard case assistant reply.");
    }

    return parsed;
  }

  async draftCustomerDecisionEmail(input: CustomerDecisionEmailInput) {
    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      temperature: 0.3,
      input: [
        {
          role: "system",
          content:
            "You write customer-facing FAKTURIO emails in Slovak when an automated invoice collection case is paused and needs the customer's decision. Write naturally and clearly, not as a raw template. Use only supplied facts. Explain what the debtor wrote, why automation paused, and what the customer can answer directly to this email. Include the dashboard link. Do not claim that any new action was already performed. Do not draft arbitrary legal threats, legal advice, discounts, debt changes, or non-standard terms. You may mention an approved final notice option only as an available predefined action. Return structured output only."
        },
        {
          role: "user",
          content: [
            `Case ID: ${input.caseId}`,
            `Invoice number: ${input.invoiceNumber}`,
            `Debtor: ${input.debtorName ?? "(unknown)"}`,
            `Amount: ${input.amountTotal ?? "(unknown)"} ${input.currency ?? "EUR"}`,
            `Due date: ${input.dueDate ?? "(unknown)"}`,
            `Decision reason:\n${input.decisionReason}`,
            `AI classification summary:\n${input.classificationSummary ?? "(none)"}`,
            `Debtor message:\n${input.debtorMessage ?? "(no readable text)"}`,
            `Customer can reply to: ${input.replyToAddress}`,
            `Dashboard link: ${input.caseUrl}`,
            `Allowed customer replies/actions:\n- ${input.allowedReplies.join("\n- ")}`
          ].join("\n\n")
        }
      ],
      text: {
        format: zodTextFormat(
          customerDecisionEmailDraftSchema,
          "customer_decision_email_draft"
        )
      }
    });

    const parsed = extractParsedResponse(
      response,
      customerDecisionEmailDraftSchema.safeParse.bind(customerDecisionEmailDraftSchema)
    );
    if (!parsed) {
      throw new Error("OpenAI response did not contain customer decision email draft.");
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

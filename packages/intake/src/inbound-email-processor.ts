import type { InboundEmail } from "@fakturio/email";
import { isAcceptedInvoiceMimeType } from "@fakturio/shared";
import {
  CustomerEmailAssistantService,
  type CustomerEmailAssistantResult
} from "./customer-email-assistant";
import { DebtorReplyService, type DebtorReplyResult } from "./debtor-reply";
import {
  InvoiceIntakeService,
  type EmailIntakeResult
} from "./service";
import {
  resolveOrganizationForInboundEmail,
  type EmailOrganizationRoute
} from "./email-routing";

export type InboundEmailProcessingResult =
  | {
      kind: "CUSTOMER_ASSISTANT";
      assistant: CustomerEmailAssistantResult;
    }
  | {
      kind: "DEBTOR_REPLY";
      reply: DebtorReplyResult;
    }
  | {
      kind: "INVOICE_INTAKE";
      route: EmailOrganizationRoute;
      intake: EmailIntakeResult;
    }
  | {
      kind: "UNMATCHED";
      reason: "NO_REPLY_CASE_OR_INTAKE_ROUTE";
    };

export async function processInboundEmail(
  email: InboundEmail
): Promise<InboundEmailProcessingResult> {
  const assistant = new CustomerEmailAssistantService();
  const assistantReply = await assistant.process(email);
  if (assistantReply) {
    return { kind: "CUSTOMER_ASSISTANT", assistant: assistantReply };
  }

  const reply = await new DebtorReplyService().process(email);
  if (reply) {
    return { kind: "DEBTOR_REPLY", reply };
  }

  const route = await resolveOrganizationForInboundEmail(email);
  if (!route) {
    return {
      kind: "UNMATCHED",
      reason: "NO_REPLY_CASE_OR_INTAKE_ROUTE"
    };
  }

  const hasAcceptedInvoiceAttachment = email.attachments.some(
    (attachment) => isAcceptedInvoiceMimeType(attachment.mimeType)
  );
  if (!hasAcceptedInvoiceAttachment) {
    const assistantByAlias = await assistant.process(email, route);
    if (assistantByAlias) {
      return { kind: "CUSTOMER_ASSISTANT", assistant: assistantByAlias };
    }
  }

  const intake = await new InvoiceIntakeService().createFromEmail({
    organizationId: route.organizationId,
    email
  });

  return {
    kind: "INVOICE_INTAKE",
    route,
    intake
  };
}

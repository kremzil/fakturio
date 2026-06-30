export const CUSTOMER_COMMUNICATION_KINDS = {
  invoiceClarificationRequest: "customer-invoice-clarification-request",
  multiAttachmentClarificationRequest:
    "customer-multi-attachment-clarification-request",
  multiAttachmentClarificationReply:
    "customer-multi-attachment-clarification-reply",
  emailAssistantMessage: "customer-email-assistant-message",
  emailAssistantReply: "customer-email-assistant-reply",
  unmatchedAssistantMessage: "customer-email-assistant-unmatched-message"
} as const;

export type CustomerCommunicationKind =
  (typeof CUSTOMER_COMMUNICATION_KINDS)[keyof typeof CUSTOMER_COMMUNICATION_KINDS];

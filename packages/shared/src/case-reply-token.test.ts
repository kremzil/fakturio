import { describe, expect, it } from "vitest";
import {
  createCaseClarificationAddress,
  createCaseReplyAddress,
  verifyCaseClarificationAddress,
  verifyCaseReplyAddress
} from "./case-reply-token";

const SECRET = "test-inbound-reply-secret-with-32-characters";

describe("signed case reply addresses", () => {
  it("round-trips a case id", () => {
    const address = createCaseReplyAddress(
      { caseId: "cm123_case-1", domain: "reply.example.com" },
      SECRET
    );

    expect(address).toMatch(/^reply\+cm123_case-1\./);
    expect(verifyCaseReplyAddress(address, SECRET)).toEqual({
      caseId: "cm123_case-1"
    });
  });

  it("rejects a tampered address", () => {
    const address = createCaseReplyAddress(
      { caseId: "case-1", domain: "reply.example.com" },
      SECRET
    );

    expect(
      verifyCaseReplyAddress(address.replace("case-1", "case-2"), SECRET)
    ).toBeNull();
  });

  it("round-trips a customer clarification address without accepting it as debtor reply", () => {
    const address = createCaseClarificationAddress(
      { caseId: "case-1", domain: "fakturio.example" },
      SECRET
    );

    expect(address).toMatch(/^clarify\+case-1\./);
    expect(verifyCaseClarificationAddress(address, SECRET)).toEqual({
      caseId: "case-1"
    });
    expect(verifyCaseReplyAddress(address, SECRET)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { FixtureEmailProvider } from "./fixture-provider";
import { parseMimeEmail } from "./mime";

describe("email provider", () => {
  it("records fixture emails for local workflow tests", async () => {
    const provider = new FixtureEmailProvider();
    const result = await provider.sendEmail({
      from: "system@example.com",
      to: ["debtor@example.com"],
      subject: "Reminder",
      textBody: "Please pay."
    });

    expect(result.provider).toBe("fixture");
    expect(provider.sent).toHaveLength(1);
  });

  it("parses MIME thread headers, body and attachments", async () => {
    const parsed = await parseMimeEmail(
      [
        "From: Debtor <debtor@example.com>",
        "To: reply@example.com",
        "Message-ID: <reply-1@example.com>",
        "In-Reply-To: <outbound-1@example.com>",
        "References: <older@example.com> <outbound-1@example.com>",
        "Subject: Re: Invoice",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Faktúra bola uhradená."
      ].join("\r\n"),
      "ses"
    );

    expect(parsed).toMatchObject({
      provider: "ses",
      providerId: "reply-1@example.com",
      messageId: "reply-1@example.com",
      inReplyTo: "outbound-1@example.com",
      references: ["older@example.com", "outbound-1@example.com"],
      from: "debtor@example.com",
      to: ["reply@example.com"],
      subject: "Re: Invoice",
      textBody: "Faktúra bola uhradená."
    });
  });
});

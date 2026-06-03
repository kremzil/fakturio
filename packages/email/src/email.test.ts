import { describe, expect, it } from "vitest";
import { FixtureEmailProvider } from "./fixture-provider";

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
});

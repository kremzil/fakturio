import { describe, expect, it } from "vitest";
import { daysAfter, STANDARD_REMINDER_SCHEDULE, startOfInvoiceDay } from "./schedules";

describe("workflow schedules", () => {
  it("computes reminder dates after due date", () => {
    expect(daysAfter("2026-06-02", STANDARD_REMINDER_SCHEDULE.firstReminderDaysAfterDue).toISOString()).toBe(
      "2026-06-03T00:00:00.000Z"
    );
  });

  it("computes the payment check date from the invoice due date", () => {
    expect(startOfInvoiceDay("2026-06-02").toISOString()).toBe("2026-06-02T00:00:00.000Z");
  });
});

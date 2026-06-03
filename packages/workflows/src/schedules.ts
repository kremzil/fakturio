export type ReminderSchedule = {
  firstReminderDaysAfterDue: number;
  secondReminderDaysAfterDue: number;
  paymentRequestDaysAfterDue: number;
  finalNoticeDaysAfterDue: number;
};

export const STANDARD_REMINDER_SCHEDULE: ReminderSchedule = {
  firstReminderDaysAfterDue: 1,
  secondReminderDaysAfterDue: 4,
  paymentRequestDaysAfterDue: 7,
  finalNoticeDaysAfterDue: 14
};

export function daysAfter(dateIso: string, days: number): Date {
  const date = new Date(`${dateIso.slice(0, 10)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

export function startOfInvoiceDay(dateIso: string): Date {
  return new Date(`${dateIso.slice(0, 10)}T00:00:00.000Z`);
}

import type { EmailProvider } from "./types";
import { FixtureEmailProvider } from "./fixture-provider";
import { MailpitEmailProvider } from "./mailpit-provider";
import { SesEmailProvider } from "./ses-provider";

export function createEmailProvider(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  if (env.EMAIL_DRIVER === "ses") {
    return new SesEmailProvider({ region: env.AWS_REGION || "eu-central-1" });
  }

  if (env.EMAIL_DRIVER === "mailpit") {
    return new MailpitEmailProvider({
      host: env.MAILPIT_SMTP_HOST || "localhost",
      port: Number(env.MAILPIT_SMTP_PORT || 1025)
    });
  }

  return new FixtureEmailProvider();
}

import type { EmailProvider } from "./types";
import { FixtureEmailProvider } from "./fixture-provider";
import { SesEmailProvider } from "./ses-provider";

export function createEmailProvider(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  if (env.EMAIL_DRIVER === "ses") {
    return new SesEmailProvider({ region: env.AWS_REGION || "eu-central-1" });
  }

  return new FixtureEmailProvider();
}

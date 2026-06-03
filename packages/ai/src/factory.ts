import type { AiProvider } from "@fakturio/shared";
import { MockAiProvider } from "./mock-provider";
import { OpenAiProvider } from "./openai-provider";

export function createAiProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
  if (env.MOCK_AI === "1" || !env.OPENAI_API_KEY) {
    return new MockAiProvider();
  }

  return new OpenAiProvider({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL || "gpt-4.1"
  });
}

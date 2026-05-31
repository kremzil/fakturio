import dotenv from "dotenv";

dotenv.config();

process.env.DATABASE_URL ||= "file:./dev.db";
process.env.OPENAI_MODEL ||= "gpt-4.1";
process.env.PORT ||= "4000";

export const env = {
  databaseUrl: process.env.DATABASE_URL,
  openAiModel: process.env.OPENAI_MODEL,
  openAiApiKey: process.env.OPENAI_API_KEY,
  mockAi: process.env.MOCK_AI === "1",
  port: Number(process.env.PORT)
};

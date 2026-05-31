import { env } from "./env.js";
import { createApp } from "./app.js";

const app = createApp();

app.listen(env.port, "127.0.0.1", () => {
  console.log(`FAKTURIO API listening on http://127.0.0.1:${env.port}`);
});

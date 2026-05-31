import express from "express";
import cors from "cors";
import multer from "multer";
import { createInvoiceRouter } from "./http/invoiceRoutes.js";
import { HttpError } from "./http/errors.js";
import type { InvoiceParsingService } from "./services/invoiceParsingService.js";

export function createApp(options: { parsingService?: InvoiceParsingService } = {}) {
  const app = express();

  app.use(cors({ origin: true }));
  app.use("/api", createInvoiceRouter(options.parsingService));

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "Súbor môže mať maximálne 20 MB." });
        return;
      }

      res.status(400).json({ error: error.message });
      return;
    }

    if (error instanceof Error && error.name === "ZodError") {
      res.status(400).json({ error: "Neplatné údaje formulára.", details: error.message });
      return;
    }

    const message = error instanceof Error ? error.message : "Unexpected server error";
    if (process.env.NODE_ENV !== "test") {
      console.error(error);
    }
    res.status(500).json({ error: message });
  });

  return app;
}

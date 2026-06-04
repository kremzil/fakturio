import { NextResponse } from "next/server";
import { InvoiceIntakeService } from "@fakturio/intake";
import { MAX_INVOICE_UPLOAD_BYTES, isAcceptedInvoiceMimeType } from "@fakturio/shared";
import { getDashboardCaseById } from "@/lib/case-data";
import { httpErrorResponse, requireSession } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { organizationId, userId } = await requireSession();

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Chýba súbor faktúry." }, { status: 400 });
    }

    if (!isAcceptedInvoiceMimeType(file.type)) {
      return NextResponse.json({ error: "Podporované sú PDF, JPG, PNG alebo WEBP faktúry." }, { status: 415 });
    }

    if (file.size > MAX_INVOICE_UPLOAD_BYTES) {
      return NextResponse.json({ error: "Maximálna veľkosť súboru je 20 MB." }, { status: 413 });
    }

    const intake = new InvoiceIntakeService();
    const result = await intake.createFromUpload({
      organizationId,
      userId,
      fileName: file.name,
      mimeType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer())
    });
    const dashboardCase = await getDashboardCaseById(result.caseId, organizationId);

    return NextResponse.json({ case: dashboardCase, parseError: result.parseError }, { status: 201 });
  } catch (error) {
    return httpErrorResponse(error);
  }
}

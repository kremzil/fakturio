import { NextResponse } from "next/server";
import { ensureLocalBootstrap } from "@fakturio/db";
import { InvoiceIntakeService } from "@fakturio/intake";
import { MAX_INVOICE_UPLOAD_BYTES, isAcceptedInvoiceMimeType } from "@fakturio/shared";
import { getDashboardCaseById } from "@/lib/case-data";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
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

    const { organization, user } = await ensureLocalBootstrap();
    const intake = new InvoiceIntakeService();
    const result = await intake.createFromUpload({
      organizationId: organization.id,
      userId: user.id,
      fileName: file.name,
      mimeType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer())
    });
    const dashboardCase = await getDashboardCaseById(result.caseId);

    return NextResponse.json({ case: dashboardCase, parseError: result.parseError }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Nahratie faktúry zlyhalo." },
      { status: 500 }
    );
  }
}

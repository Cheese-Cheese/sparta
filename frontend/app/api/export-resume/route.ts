import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.formData();
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "https://sparta-1l4n.onrender.com";
    const response = await fetch(`${backendUrl}/export_resume`, {
      method: "POST",
      body,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      return NextResponse.json(
        { error: typeof failure.detail === "string" ? failure.detail : "Could not save the PDF. Please retry." },
        { status: response.status },
      );
    }
    return new Response(await response.arrayBuffer(), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="resume-reconstructed.pdf"',
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Could not reach the backend to save the PDF." }, { status: 502 });
  }
}

import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { resumeText, spokenTranscript, context, mode } = await req.json();

    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "https://sparta-1l4n.onrender.com";
    const response = await fetch(`${backendUrl}/rebuild`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resume_text: resumeText,
        spoken_transcript: spokenTranscript || "",
        context: context || "",
        mode: mode || "interview"
      }),
    });

    // Explicitly check if the Python server failed
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const error = typeof failure.detail === "string" ? failure.detail : "Resume reconstruction failed. Please retry.";
      return NextResponse.json({ error }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json(data);
    
  } catch (error: any) {
    console.error("Next.js API Route Error:", error.message);
    return NextResponse.json({ error: "Failed to connect to backend." }, { status: 500 });
  }
}

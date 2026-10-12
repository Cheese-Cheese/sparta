import { NextResponse } from "next/server";
import axios from "axios";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { message, history, context } = body;

    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "https://sparta-1l4n.onrender.com";
    const response = await axios.post(`${backendUrl}/chat`, {
      message,
      history,
      context,
    });

    return NextResponse.json(response.data);
  } catch (error: any) {
    console.error("Error in interrogation route:", error.message);
    return NextResponse.json(
      { error: "Failed to communicate with AI engine" },
      { status: 500 }
    );
  }
}

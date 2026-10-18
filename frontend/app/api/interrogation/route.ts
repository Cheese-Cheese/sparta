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
  } catch (error: unknown) {
    const upstream = axios.isAxiosError(error) ? error.response : undefined;
    const detail = upstream?.data?.detail;
    return NextResponse.json(
      { error: typeof detail === "string" ? detail : "Failed to communicate with AI engine" },
      { status: upstream?.status || 502 }
    );
  }
}

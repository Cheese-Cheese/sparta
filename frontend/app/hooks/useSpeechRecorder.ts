"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SpeechRecorder, type RecordingState } from "../lib/speech-recorder";

export function useSpeechRecorder(onTranscript: (text: string) => void) {
  const session = useRef<SpeechRecorder | null>(null);
  const [state, setState] = useState<RecordingState>("idle");
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (session.current && session.current.status !== "idle") return;
    session.current?.dispose();
    const recorder = new SpeechRecorder({ onState: setState, onTranscript, onError: setError });
    session.current = recorder;
    await recorder.start();
  }, [onTranscript]);

  const stop = useCallback(() => session.current?.stop() ?? Promise.resolve(""), []);
  useEffect(() => () => session.current?.dispose(), []);

  return {
    start, stop, error,
    isListening: state === "listening",
    isConnecting: state === "connecting",
    isFinishing: state === "finishing",
  };
}

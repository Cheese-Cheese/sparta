export type RecordingState = "idle" | "connecting" | "listening" | "finishing";

interface Callbacks {
  onState: (state: RecordingState) => void;
  onTranscript: (text: string) => void;
  onError: (message: string | null) => void;
}

function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Microphone access was blocked. Allow microphone access for this page and in your device's privacy settings.";
    }
    if (error.name === "NotFoundError") return "No microphone was found. Connect a microphone and try again.";
    if (error.name === "NotReadableError") return "The microphone could not start. Check whether another app is using it.";
    if (error.name === "NotSupportedError") return "This browser cannot record this audio format. Try a browser with microphone recording support.";
  }
  return error instanceof Error ? error.message : "Microphone recording failed. Please try again.";
}

/** Owns one microphone stream, including the final audio chunk and transcript. */
export class SpeechRecorder {
  status: RecordingState = "idle";
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private socket: WebSocket | null = null;
  private abort = new AbortController();
  private disposed = false;
  private committed = "";
  private interim = "";
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private finishPromise: Promise<string> | null = null;
  private resolveFinish: ((text: string) => void) | null = null;

  constructor(private callbacks: Callbacks) {}

  private setState(state: RecordingState) {
    this.status = state;
    if (!this.disposed) this.callbacks.onState(state);
  }

  private text() {
    return `${this.committed} ${this.interim}`.trim();
  }

  private stopTracks() {
    this.stream?.getTracks().forEach(track => {
      track.onended = null;
      track.stop();
    });
  }

  private cleanup() {
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.abort.abort();
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.onerror = null;
      if (this.recorder.state !== "inactive") this.recorder.stop();
    }
    this.stopTracks();
    if (this.socket) {
      this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
      this.socket.close();
    }
    this.recorder = null;
    this.socket = null;
    this.stream = null;
  }

  private complete() {
    const text = this.text();
    this.cleanup();
    if (!text && !this.disposed) {
      this.callbacks.onError("No speech was detected. Check your selected microphone and input volume, then try again.");
    }
    this.setState("idle");
    this.resolveFinish?.(text);
    this.resolveFinish = null;
  }

  private fail(message: string) {
    if (this.disposed) return;
    this.cleanup();
    this.callbacks.onError(message);
    this.setState("idle");
    this.resolveFinish?.("");
    this.resolveFinish = null;
  }

  async start() {
    if (this.disposed || this.status !== "idle") return;
    this.callbacks.onError(null);
    this.callbacks.onTranscript("");
    this.setState("connecting");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("Microphone recording is unavailable in this browser. Open this page in a browser with microphone support.");
      }
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.disposed) { this.stopTracks(); return; }
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
        .find(type => MediaRecorder.isTypeSupported(type));
      this.recorder = mimeType ? new MediaRecorder(this.stream, { mimeType }) : new MediaRecorder(this.stream);
      const response = await fetch("/api/deepgram", { signal: this.abort.signal });
      const data = await response.json();
      if (this.disposed) return;
      if (!response.ok || !data.key) throw new Error(data.error || "Deepgram credentials are unavailable. Check the frontend configuration.");

      const socket = new WebSocket(
        "wss://api.deepgram.com/v1/listen?model=nova-2&interim_results=true&smart_format=true",
        ["token", data.key],
      );
      this.socket = socket;
      this.connectionTimer = setTimeout(() => this.fail("The speech service did not connect. Check your network and try again."), 15000);
      socket.onopen = () => {
        if (this.connectionTimer) clearTimeout(this.connectionTimer);
        try {
          const recorder = this.recorder!;
          recorder.ondataavailable = event => {
            if (event.data.size && socket.readyState === WebSocket.OPEN) socket.send(event.data);
          };
          recorder.onerror = () => this.fail("The microphone stopped recording. Check your microphone and try again.");
          recorder.onstop = () => {
            this.stopTracks();
            // MediaRecorder sends its last dataavailable event before onstop.
            if (this.status === "finishing" && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "CloseStream" }));
            }
          };
          this.stream!.getTracks().forEach(track => {
            track.onended = () => this.fail("The microphone disconnected. Reconnect it and try again.");
          });
          recorder.start(250);
          this.setState("listening");
        } catch (error) { this.fail(microphoneError(error)); }
      };
      socket.onmessage = event => {
        try {
          const result = JSON.parse(event.data);
          if (result.type === "Error" || result.err_code) {
            this.fail("Deepgram could not transcribe the audio. Check your account's speech access and credits.");
            return;
          }
          const text = result.channel?.alternatives?.[0]?.transcript;
          if (text) {
            if (result.is_final) { this.committed = `${this.committed} ${text}`.trim(); this.interim = ""; }
            else this.interim = text;
            this.callbacks.onTranscript(this.text());
          }
          if (result.type === "Metadata" && this.status === "finishing") this.complete();
        } catch { this.fail("The speech service returned an unreadable response. Please try again."); }
      };
      socket.onerror = () => this.fail("The speech connection failed. Check your network, Deepgram speech permissions, and account credits.");
      socket.onclose = event => {
        if (this.status === "finishing" && event.code === 1000) this.complete();
        else this.fail(`The speech connection closed (code ${event.code}). Check your network and Deepgram account, then try again.`);
      };
    } catch (error) { this.fail(microphoneError(error)); }
  }

  stop(): Promise<string> {
    if (this.status === "finishing") return this.finishPromise!;
    if (this.status === "connecting") { this.dispose(); return Promise.resolve(""); }
    if (this.status !== "listening") return Promise.resolve("");
    this.setState("finishing");
    this.finishPromise = new Promise(resolve => { this.resolveFinish = resolve; });
    this.finishTimer = setTimeout(() => this.fail("Transcription took too long to finish. Please try recording your answer again."), 5000);
    try { this.recorder!.stop(); }
    catch (error) { this.fail(microphoneError(error)); }
    return this.finishPromise;
  }

  dispose() {
    this.disposed = true;
    this.cleanup();
    this.status = "idle";
    this.resolveFinish?.("");
    this.resolveFinish = null;
  }
}

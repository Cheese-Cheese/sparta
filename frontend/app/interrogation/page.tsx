"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic,
  MicOff,
  PhoneOff,
  Activity,
  ArrowLeft,
  Wrench,
  Check,
  Copy,
  ShieldCheck,
  Award,
  ChevronRight,
  Play,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import axios from "axios";
import { useRouter } from "next/navigation";
import ThemeToggle from "../components/ThemeToggle";
import SpartaLogo from "../components/SpartaLogo";
import { useSpeechRecorder } from "../hooks/useSpeechRecorder";

export default function InterrogationPage() {
  const router = useRouter();
  const [hasStarted, setHasStarted] = useState(false);
  const [transcript, setTranscript] = useState("Click 'Start interview' to begin...");
  const [userTranscript, setUserTranscript] = useState("");
  const { start: startMicrophone, stop: finishRecording, isListening, isConnecting, isFinishing, error: microphoneError } = useSpeechRecorder(setUserTranscript);
  const [chatHistory, setChatHistory] = useState<{ type: string; text: string }[]>([]);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);

  // Turn Management State
  const [currentTurn, setCurrentTurn] = useState(0);
  const [turnQuestions, setTurnQuestions] = useState<{ [key: number]: string }>({});
  const [turnTopics, setTurnTopics] = useState<{ [key: number]: string }>({});
  const [showReport, setShowReport] = useState(false);

  // Stored session state
  const [roastData, setRoastData] = useState<any>(null);
  const [rawResumeText, setRawResumeText] = useState("");

  // Report state
  const [rebuildBullets, setRebuildBullets] = useState<{ original: string; enhanced: string }[]>([]);
  const [defenseReport, setDefenseReport] = useState<any>(null);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [showTranscriptModal, setShowTranscriptModal] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const audioPlayer = useRef<HTMLAudioElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const typewriterTimer = useRef<NodeJS.Timeout | null>(null);
  const isInterrogationEndedRef = useRef<boolean>(false);
  const isConclusionReachedRef = useRef<boolean>(false);

  useEffect(() => {
    try {
      const storedData = sessionStorage.getItem("sparta_roast_data");
      const storedResume = sessionStorage.getItem("sparta_resume_text");

      if (!storedData || !storedResume) {
        console.warn("No resume data found, redirecting to home...");
        window.location.href = "/";
        return;
      }

      if (storedData) {
        setRoastData(JSON.parse(storedData));
      }
      if (storedResume) {
        setRawResumeText(storedResume);
      }
    } catch (e) {
      console.error("Error reading session storage:", e);
      window.location.href = "/";
    }
  }, [router]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || isConnecting || isFinishing) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.code === "Space" && hasStarted && !showReport) {
        e.preventDefault();
        if (isListening) {
          stopMicrophone();
        } else {
          startMicrophone();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasStarted, showReport, isListening, isConnecting, isFinishing, currentTurn, userTranscript]);

  const handleStartInterrogation = () => {
    setHasStarted(true);
    // User interaction gesture unlocks browser HTML5 audio element
    if (audioPlayer.current) {
      audioPlayer.current.play().catch(() => {});
    }

    const initPrompt = `Start the interrogation at TURN 0 (INTRO). Ask the candidate to introduce themselves.`;
    triggerAiResponse(initPrompt, 0);
  };

  const stopMicrophone = async () => {
    const answer = await finishRecording();
    if (answer && !isInterrogationEndedRef.current && !isConclusionReachedRef.current) {
      const nextTurn = currentTurn + 1;
      setCurrentTurn(nextTurn);
      triggerAiResponse(answer, nextTurn);
    }
  };

  const triggerAiResponse = async (userMessage: string, targetTurn: number) => {
    if (isInterrogationEndedRef.current || isConclusionReachedRef.current) return;

    setIsAiSpeaking(true);
    setTranscript("");
    setUserTranscript("");

    // Stop any previously playing audio or typewriter timers
    if (audioPlayer.current) {
      audioPlayer.current.ontimeupdate = null;
      audioPlayer.current.onended = null;
      audioPlayer.current.pause();
      audioPlayer.current.currentTime = 0;
      audioPlayer.current.removeAttribute("src");
      audioPlayer.current.load();
    }
    if (typewriterTimer.current) {
      clearInterval(typewriterTimer.current);
    }

    try {
      const res = await axios.post("/api/interrogation", {
        message: userMessage,
        history: chatHistory,
        context: JSON.stringify(roastData || {}),
      });

      if (isInterrogationEndedRef.current) return;

      const rawReplyText =
        res.data.response ||
        res.data.reply ||
        (typeof res.data === "string" ? res.data : JSON.stringify(res.data));

      let extractedTopic = `Turn ${targetTurn}`;
      let cleanText = rawReplyText.toString().trim();

      const topicMatch = cleanText.match(/\[TOPIC:\s*(.*?)\]/i);
      if (topicMatch) {
        extractedTopic = topicMatch[1].trim();
        cleanText = cleanText.replace(topicMatch[0], "").trim();
      }

      cleanText = cleanText.replace(/[*#`_\[\]]/g, "").trim();

      if (extractedTopic.toLowerCase().includes("conclusion") || cleanText.toLowerCase().includes("thank you for participating")) {
        isConclusionReachedRef.current = true;
      }

      // Store the actual question asked for this turn
      setTurnQuestions((prev) => ({ ...prev, [targetTurn]: cleanText }));
      setTurnTopics((prev) => ({ ...prev, [targetTurn]: extractedTopic }));

      // Update chat history immediately so interruptions don't cause history loss
      setChatHistory((prev) => [
        ...prev,
        { type: "user", text: userMessage },
        { type: "model", text: rawReplyText },
      ]);

      const words = cleanText.split(" ");
      let audioPlayed = false;

      // Deepgram TTS Fetch & Audio-synced text reveal
      try {
        const tokenRes = await fetch("/api/deepgram");
        const tokenData = await tokenRes.json();
        if (tokenData.key && !isInterrogationEndedRef.current) {
          const cleanTtsPayload = cleanText.slice(0, 350);

          const audioRes = await fetch(
            "https://api.deepgram.com/v1/speak?model=aura-athena-en",
            {
              method: "POST",
              headers: {
                Authorization: `Token ${tokenData.key}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ text: cleanTtsPayload }),
            }
          );

          if (isInterrogationEndedRef.current) return;

          const audioBlob = await audioRes.blob();
          if (audioBlob && audioBlob.size > 100 && audioPlayer.current && !isInterrogationEndedRef.current) {
            const audioUrl = URL.createObjectURL(audioBlob);
            audioPlayer.current.src = audioUrl;

            audioPlayer.current.ontimeupdate = () => {
              if (
                audioPlayer.current &&
                audioPlayer.current.duration > 0 &&
                audioPlayer.current.currentTime > 0.05 &&
                !isInterrogationEndedRef.current
              ) {
                const progress =
                  audioPlayer.current.currentTime / audioPlayer.current.duration;
                const wordIndex = Math.min(
                  words.length,
                  Math.floor(progress * words.length) + 1
                );
                setTranscript(words.slice(0, wordIndex).join(" "));
              }
            };

            audioPlayer.current.onended = () => {
              if (!isInterrogationEndedRef.current) {
                setTranscript(cleanText);
                setIsAiSpeaking(false);

                // Auto-redirect to Results if Conclusion finishes speaking
                if (
                  // targetTurn >= 8 ||
                  extractedTopic.toLowerCase().includes("conclusion") ||
                  cleanText.toLowerCase().includes("thank you for participating")
                ) {
                  handleFinishInterrogation();
                }
              }
            };

            try {
              if (!isInterrogationEndedRef.current) {
                await audioPlayer.current.play();
                audioPlayed = true;
              }
            } catch (playErr: any) {
              if (playErr.name !== "AbortError") {
                console.warn("Audio playback interrupted:", playErr);
              }
            }
          }
        }
      } catch (err) {
        console.error("TTS Error:", err);
      }

      if (!audioPlayed && !isInterrogationEndedRef.current) {
        let currentText = "";
        let i = 0;
        typewriterTimer.current = setInterval(() => {
          if (isInterrogationEndedRef.current) {
            if (typewriterTimer.current) clearInterval(typewriterTimer.current);
            return;
          }
          if (i < words.length) {
            currentText += (i > 0 ? " " : "") + words[i];
            setTranscript(currentText);
            i++;
          } else {
            if (typewriterTimer.current) clearInterval(typewriterTimer.current);
            setIsAiSpeaking(false);
            if (
              // targetTurn >= 8 ||
              extractedTopic.toLowerCase().includes("conclusion") ||
              cleanText.toLowerCase().includes("thank you for participating")
            ) {
              handleFinishInterrogation();
            }
          }
        }, 120);
      }
    } catch (e) {
      console.error(e);
      if (!isInterrogationEndedRef.current) {
        const detail = axios.isAxiosError(e) ? e.response?.data?.error : undefined;
        setTranscript(typeof detail === "string" ? detail : "SYS_ERR: Connection lost to S.P.A.R.T.A. main node.");
        setIsAiSpeaking(false);
      }
    }
  };
  const copyTranscriptToClipboard = () => {
    const rawTranscript = chatHistory
      .filter((msg, idx) => !(idx === 0 && msg.type === "user" && msg.text.includes("Start the interrogation at TURN 0")))
      .map((msg) => `${msg.type === "user" ? "Candidate" : "S.P.A.R.T.A. Agent"}\n${msg.text}`)
      .join("\n\n");
    navigator.clipboard.writeText(rawTranscript).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }).catch(err => {
      console.error("Failed to copy transcript:", err);
    });
  };
  const handleFinishInterrogation = async () => {
    if (isInterrogationEndedRef.current) return;
    // Set flag first to block all in-flight async TTS play calls
    isInterrogationEndedRef.current = true;

    // Instant voice cutoff: silence and unload audio player immediately
    if (audioPlayer.current) {
      audioPlayer.current.pause();
      audioPlayer.current.currentTime = 0;
      audioPlayer.current.removeAttribute("src");
      audioPlayer.current.load();
    }
    if (typewriterTimer.current) {
      clearInterval(typewriterTimer.current);
    }
    setIsAiSpeaking(false);
    const finalAnswer = await finishRecording();

    setIsGeneratingReport(true);
    setShowReport(true);

    const fullVoiceTranscript = [...chatHistory, ...(finalAnswer ? [{ type: "user", text: finalAnswer }] : [])]
      .map((h) => `${h.type === "user" ? "Candidate" : "Agent"}: ${h.text}`)
      .join("\n");

    try {
      const res = await fetch("/api/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resumeText: rawResumeText || "Worked on backend APIs and system infrastructure.",
          spokenTranscript: fullVoiceTranscript || userTranscript || "",
          context: JSON.stringify(roastData || {}),
        }),
      });
      const data = await res.json();
      setRebuildBullets(data.bullets || []);
      setDefenseReport(data);
    } catch (e) {
      console.error("Error generating report bullets:", e);
    }
    setIsGeneratingReport(false);
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript, userTranscript]);

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  if (!roastData || !rawResumeText) {
    return (
      <div className="min-h-screen bg-surface flex flex-col items-center justify-center font-sans text-danger">
        <Activity className="animate-pulse mb-4" size={32} />
        <p>Initializing Secure Connection...</p>
      </div>
    );
  }

  return (
    <div className={`interview-page min-h-screen bg-canvas text-ink flex flex-col font-sans ${showReport ? "" : "lg:h-dvh lg:overflow-hidden"}`}>
      <audio ref={audioPlayer} className="hidden" />

      {/* Top Header */}
      <header className="shrink-0 border-b-2 border-line bg-surface px-5 sm:px-8 py-5 flex flex-wrap gap-4 items-center justify-between sticky top-0 z-40">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/"
            className="flex items-center gap-2 text-muted hover:text-ink transition-colors text-xs font-sans"
          >
            <ArrowLeft size={16} /> Return to Dashboard
          </Link>
          <div className="h-4 w-px bg-line" />
          <div className="flex items-center gap-2">
            <SpartaLogo alt="S.P.A.R.T.A. logo" className="h-11 sm:h-13 w-auto shrink-0" />
            <h1 className="font-mono font-bold tracking-wide text-sm sm:text-base uppercase">Interview practice</h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <ThemeToggle />
          <span className="px-3 py-1.5 bg-secondary-soft border border-line text-secondary text-xs font-mono rounded-none">
            {showReport ? "INTERVIEW FEEDBACK" : (roastData?.has_github ? "CODE-BASED INTERVIEW" : "RESUME-BASED INTERVIEW")}
          </span>
        </div>
      </header>

      {/* Main Content */}
      <main className={`flex-1 min-h-0 flex flex-col p-6 max-w-7xl w-full mx-auto relative ${showReport ? "" : "lg:overflow-hidden"}`}>
        {/* User Interaction Start Modal (Fixes Browser Audio Autoplay Blocking) */}
        {!hasStarted && !showReport && (
          <div className="absolute inset-0 z-30 bg-canvas/95  flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-surface border border-line rounded-xl p-8 max-w-lg w-full text-center space-y-6 shadow-none"
            >
              <div className="w-16 h-16 rounded-none bg-secondary-soft border border-line text-secondary flex items-center justify-center mx-auto">
                <Activity size={32} />
              </div>
              <div className="space-y-2">
                <h2 className="text-2xl font-bold text-ink tracking-tight">
                  Practise your technical interview
                </h2>
                <p className="text-sm text-muted leading-relaxed">
                  Explain your experience in your own words. Use your microphone to answer each question, then review the feedback.
                </p>
              </div>
              <button
                onClick={handleStartInterrogation}
                className="w-full py-4 bg-accent hover:bg-accent-hover text-on-accent font-bold rounded-none transition-all flex items-center justify-center gap-2 text-sm shadow-none cursor-pointer"
              >
                <Play size={18} /> Start interview
              </button>
            </motion.div>
          </div>
        )}

        {!showReport ? (
          /* Live Interrogation Terminal View */
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-6 bg-surface border border-line rounded-2xl shadow-none overflow-hidden">
            {/* Left Column: Context & Structured Topic Progression Panel */}
            <div className="h-[35dvh] min-h-[180px] lg:h-auto lg:min-h-0 lg:w-1/3 overflow-hidden border-b lg:border-b-0 lg:border-r border-line p-6 bg-tint flex flex-col gap-6">

              {/* Structured Topic Progression Panel */}
              <div className="flex-1 min-h-0 overflow-hidden bg-tint border border-line rounded-none p-5 space-y-4 flex flex-col">
                <h4 className="shrink-0 text-xs font-mono text-muted uppercase tracking-wide border-b border-line pb-2">
                  Topic Progression
                </h4>

                <div id="topic-progression-container" tabIndex={0} aria-label="Interview questions" className="flex-1 min-h-0 space-y-3 text-xs overflow-y-auto overscroll-contain pr-2 custom-scrollbar relative">
                  {Array.from({ length: currentTurn + 1 }).map((_, turnNum) => {
                    const questionText = turnQuestions[turnNum];
                    const label = turnTopics[turnNum] || `Turn ${turnNum}`;
                    const isCurrent = currentTurn === turnNum;
                    const isCompleted = turnNum < currentTurn || !!questionText;

                    return (
                      <div
                        key={turnNum}
                        ref={(el) => {
                          if (isCurrent && el) {
                            const container = document.getElementById("topic-progression-container");
                            if (container) {
                              container.scrollTo({
                                top: el.offsetTop - container.offsetTop - (container.clientHeight / 2) + (el.clientHeight / 2),
                                behavior: 'smooth'
                              });
                            }
                          }
                        }}
                        className={`p-3 rounded-none border transition-all ${
                          isCurrent
                            ? "bg-secondary-soft border-secondary text-ink"
                            : isCompleted
                            ? "bg-tint border-line text-copy"
                            : "bg-tint border-line text-muted"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className={`font-sans font-bold ${isCurrent ? "text-brand" : "text-muted"}`}>
                            {label}
                          </span>
                          {isCurrent && isAiSpeaking && (
                            <span className="flex items-center gap-1 text-[10px] text-danger font-sans animate-pulse">
                              <Loader2 size={10} className="animate-spin" /> Asking...
                            </span>
                          )}
                        </div>

                        {questionText ? (
                          <p className="text-xs leading-relaxed font-medium line-clamp-3">
                            "{questionText}"
                          </p>
                        ) : (
                          <div className="flex items-center gap-2 py-1 text-muted font-sans">
                            <span className="inline-block w-2 h-2 rounded-none bg-line animate-pulse" />
                            <span>{isCurrent ? "Processing..." : "Awaiting..."}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Right Column: Live Spoken Transcript */}
            <div className="flex-1 p-6 flex flex-col relative bg-surface min-w-0 min-h-[500px] lg:min-h-0">
              <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto pb-12 space-y-6">
                <AnimatePresence>
                  {userTranscript && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-start gap-4 self-end justify-end"
                    >
                      <div className="text-base text-copy font-normal leading-relaxed max-w-xl text-right bg-tint border border-line rounded-none p-4">
                        {userTranscript}
                        {isListening && <span className="inline-block w-2 h-4 bg-muted ml-2 animate-pulse" />}
                      </div>
                      <div className="w-8 h-8 rounded-none bg-tint border border-line text-muted flex items-center justify-center font-bold text-xs flex-shrink-0">
                        YOU
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-none bg-surface text-ink flex items-center justify-center font-bold text-xs flex-shrink-0">
                    AI
                  </div>
                  <div className="text-lg sm:text-xl text-ink font-normal leading-relaxed max-w-2xl bg-surface border border-line rounded-none p-5 min-h-[90px] flex items-center">
                    {transcript ? (
                      <div>
                        {transcript}
                        {isAiSpeaking && (
                          <span className="inline-block w-2 h-5 bg-brand ml-2 animate-pulse align-middle rounded-none shadow-none" />
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <span className="w-2 h-5 bg-brand animate-pulse rounded-none inline-block align-middle shadow-none" />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {microphoneError && <p role="alert" className="shrink-0 mb-3 border border-danger/30 bg-danger-soft p-3 text-sm text-danger">{microphoneError}</p>}
              <p role="status" className="shrink-0 mb-3 text-center text-xs text-muted">
                {isConnecting ? "Connecting microphone…" : isFinishing ? "Finishing transcription…" : isListening ? "Microphone is recording. Speak, then stop to send your answer." : "Tap to speak and allow microphone access when asked."}
              </p>
              {/* Bottom Controls */}
              <div className="shrink-0 pt-4 border-t border-line flex flex-wrap items-center justify-center gap-3">
                <button
                  onClick={isListening ? stopMicrophone : startMicrophone}
                  disabled={isConnecting || isFinishing}
                  className={`px-6 py-3.5 rounded-none font-bold transition-all flex items-center gap-2 border cursor-pointer disabled:opacity-50 ${
                    isListening
                      ? "bg-danger-soft border-danger text-danger animate-pulse shadow-none"
                      : "bg-accent border-line text-on-accent hover:bg-accent-hover"
                  }`}
                >
                  {isListening ? <MicOff size={18} /> : <Mic size={18} />}
                  {isConnecting ? "Connecting…" : isFinishing ? "Transcribing…" : isListening ? "Stop Speaking & Send (Space)" : "Tap to Speak (Space)"}
                </button>

                <button
                  onClick={handleFinishInterrogation}
                  className="px-8 py-3.5 bg-brand hover:bg-brand-hover text-on-brand font-bold rounded-none transition-colors flex items-center gap-2 shadow-none cursor-pointer"
                >
                  <PhoneOff size={18} /> Finish & view feedback
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Post-Interrogation Battle Report View */
          <div className="space-y-6 animate-[fadeIn_0.5s_ease_forwards]">
            {/* Header Score Card */}
            <div className="review-score bg-surface border border-line rounded-2xl p-8 flex flex-col md:flex-row items-center justify-between gap-6">
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <Award className="text-warning" size={26} />
                  <h2 className="text-3xl font-bold tracking-[-0.04em] text-ink">Your interview review</h2>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-3 py-1 bg-danger-soft border border-danger/20 text-danger font-sans text-xs rounded-none uppercase tracking-wide font-bold">
                    {isGeneratingReport ? "REVIEWING ANSWERS…" : defenseReport?.mode_evaluated || "VERBAL DEFENSE AUDIT"}
                  </span>
                  {isGeneratingReport ? (
                    <span className="px-3 py-1 bg-tint text-ink font-sans text-xs rounded-none font-bold flex items-center gap-2">
                      <Loader2 className="animate-spin" size={12} /> PREPARING FEEDBACK
                    </span>
                  ) : defenseReport?.defense_verdict && (
                    <span className="px-3 py-1 bg-tint text-ink font-sans text-xs rounded-none font-bold">
                      VERDICT: {defenseReport.defense_verdict}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted">
                  {roastData?.has_github
                    ? "Code and Resume grounded voice defense evaluation derived from your spoken answers."
                    : "Resume grounded voice defense evaluation derived from your spoken answers."}
                </p>
              </div>

              <div className="flex items-center gap-6">
                <button
                  onClick={() => setShowTranscriptModal(true)}
                  className="px-4 py-2 bg-surface hover:bg-tint text-copy text-xs font-sans rounded-none transition-colors border border-line cursor-pointer"
                >
                  View Transcript
                </button>
                <div className="text-center bg-secondary-soft border border-line rounded-none px-6 py-4">
                  <p className="text-xs font-sans text-muted uppercase tracking-wide mb-1">
                    Interview score
                  </p>
                  <span className="text-4xl font-bold text-danger">
                    {isGeneratingReport ? (
                      <Loader2 className="animate-spin inline-block mr-2" size={32} />
                    ) : (
                      `${defenseReport?.overall_defense_score ?? 0}/100`
                    )}
                  </span>
                </div>
              </div>
            </div>

            {/* Phase 1: Mistakes & Failsafes */}
            {defenseReport?.phase1_mistakes && (
              <div className="bg-surface border border-line rounded-2xl p-8 space-y-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-xl font-bold text-ink flex items-center gap-2">
                    <Activity className="text-danger" size={22} />
                    Technical feedback
                  </h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {defenseReport.phase1_mistakes.map((mistake: any, idx: number) => (
                    <div
                      key={idx}
                      className="bg-tint border border-line rounded-none p-5 flex flex-col gap-3 relative overflow-hidden"
                    >
                      {mistake.is_unanswered && (
                         <div className="absolute top-0 left-0 w-full h-1 bg-warning" />
                      )}

                      <div className="flex items-center justify-between">
                        <span className="text-xs font-sans font-bold text-muted">
                          {mistake.question_label}
                        </span>
                        <span className={`px-2.5 py-1 font-sans text-xs rounded-none font-bold ${
                          mistake.score >= 80 ? 'bg-tint text-brand border border-line' :
                          mistake.score >= 50 ? 'bg-warning-soft text-warning border border-warning/20' :
                          'bg-danger-soft text-danger border border-danger/20'
                        }`}>
                          {mistake.score}/100
                        </span>
                      </div>

                      {mistake.feedback === "QUESTION NOT ANSWERED" ? (
                        <p className="text-sm text-danger font-bold text-center my-4 uppercase tracking-wide">
                          QUESTION NOT ANSWERED
                        </p>
                      ) : (
                        <p className="text-sm text-copy leading-relaxed font-medium">
                          "{mistake.feedback}"
                        </p>
                      )}

                      {mistake.is_unanswered && mistake.failsafe_recommendation && (
                        <div className="mt-auto pt-3 border-t border-line">
                          <p className="text-xs font-sans text-warning mb-1 flex items-center gap-1">
                            Suggested next step
                          </p>
                          <p className="text-xs text-warning">
                            {mistake.failsafe_recommendation}
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Phase 2: Corrections / Additions */}
            <div className="bg-surface border border-line rounded-2xl p-8 space-y-6">
              <div className="flex items-center gap-3">
                <Wrench className="text-ink" size={22} />
                <h3 className="text-xl font-bold text-ink">Resume suggestions</h3>
              </div>
              <p className="text-sm text-muted">
                Actionable bullet points derived from your mock interview defense to fix gaps in your resume:
              </p>

              {isGeneratingReport ? (
                <div className="py-12 text-center text-muted font-sans animate-pulse">
                  Preparing feedback and resume suggestions from your answers…
                </div>
              ) : defenseReport?.phase2_corrections?.length === 0 ? (
                <div className="py-8 text-center text-danger font-bold font-sans border border-danger/20 bg-danger-soft rounded-none">
                  Answer the resume questions to receive bullet suggestions.
                </div>
              ) : (
                <div className="space-y-4">
                  {defenseReport?.phase2_corrections?.map((correction: any, idx: number) => (
                    <div
                      key={idx}
                      className="bg-tint border border-line rounded-none p-5 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-xs font-sans text-brand mb-1 flex items-center gap-2">
                            <ShieldCheck size={14} /> Category: {correction.category || "Addition"}
                          </p>
                          <p className="text-sm text-ink font-medium leading-relaxed">
                            {correction.bullet}
                          </p>
                        </div>
                        <button
                          onClick={() => copyToClipboard(correction.bullet, idx)}
                          className="px-3 py-1.5 bg-surface hover:bg-tint text-copy text-xs font-sans rounded-none transition-colors border border-line flex items-center gap-1.5 flex-shrink-0 cursor-pointer"
                        >
                          {copiedIndex === idx ? <Check size={14} className="text-brand" /> : <Copy size={14} />}
                          {copiedIndex === idx ? "Copied" : "Copy Bullet"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Back Button */}
            <div className="flex justify-center pt-4">
              <Link
                href="/"
                className="retro-button px-8 py-3.5 bg-brand hover:bg-brand-hover text-on-brand font-bold rounded-none transition-all flex items-center gap-2"
              >
                <ArrowLeft size={18} /> Return to dashboard
              </Link>
            </div>
          </div>
        )}

        {/* Transcript Modal */}
        {showTranscriptModal && (
          <div
            className="fixed inset-0 z-50 bg-overlay  flex items-center justify-center p-6"
            onClick={() => setShowTranscriptModal(false)}
          >
            <div
              className="bg-surface border border-line rounded-none p-8 max-w-2xl w-full flex flex-col max-h-[80vh] shadow-none"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-6 border-b border-line pb-4">
                <h3 className="text-xl font-bold text-ink">Interview transcript</h3>
                <div className="flex items-center space-x-3">
                  <button
                    onClick={copyTranscriptToClipboard}
                    className="p-2 text-brand hover:text-brand-hover bg-tint hover:bg-surface rounded-none transition-colors cursor-pointer border border-line text-sm font-medium w-32"
                  >
                    {isCopied ? "Copied!" : "Copy Transcript"}
                  </button>
                  <button
                    onClick={() => setShowTranscriptModal(false)}
                    className="p-2 text-muted hover:text-ink bg-tint hover:bg-surface rounded-none transition-colors cursor-pointer text-sm"
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
                {chatHistory.length === 0 ? (
                  <p className="text-muted text-center font-sans py-8">No transcript recorded.</p>
                ) : (
                  chatHistory
                    .filter((msg, idx) => !(idx === 0 && msg.type === "user" && msg.text.includes("Start the interrogation at TURN 0")))
                    .map((msg, idx) => (
                    <div key={idx} className={`p-4 rounded-none ${msg.type === "user" ? "bg-tint ml-12 border border-line" : "bg-danger-soft border border-danger/20 mr-12"}`}>
                      <p className={`text-xs font-sans font-bold mb-2 uppercase tracking-wide ${msg.type === "user" ? "text-muted" : "text-danger"}`}>
                        {msg.type === "user" ? "Candidate" : "S.P.A.R.T.A. Agent"}
                      </p>
                      <p className="text-sm text-copy leading-relaxed">
                        {msg.text}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

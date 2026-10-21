"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  DragEvent,
  ChangeEvent,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  UploadCloud,
  FileText,
  Briefcase,
  Code2,
  BarChart2,
  Shield,
  AlertTriangle,
  Mic,
  CheckCircle,
  Clock,
  MicOff,
  PhoneOff,
  Activity,
  Wrench,
  CheckCircle2,
  Copy,
  RefreshCcw,
  ArrowUpRight,
} from "lucide-react";
import { prepare, layout } from '@chenglou/pretext';
import axios from "axios";
import ThemeToggle from "./components/ThemeToggle";
import SpartaLogo from "./components/SpartaLogo";
import TypewriterHeading from "./components/TypewriterHeading";
import TypewriterText from "./components/TypewriterText";
import EvidenceNotice, { type EvidenceCheck, type RepositoryCoverage } from "./components/EvidenceNotice";
import { useSpeechRecorder } from "./hooks/useSpeechRecorder";

// ─────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────
type AppState = "idle" | "processing" | "done" | "error" | "interview" | "rebuild";

interface SectionData {
  score: number;
  roast: string;
}

interface RoastSections {
  experience: SectionData;
  skills: SectionData;
  formatting: SectionData;
  ats_compatibility: SectionData;
}

export interface RoastData {
  combat_readiness_score: number;
  verdict: string;
  ats_metrics: {
    keyword_match_rate: number;
    quantification_rate: number;
    missing_critical_skills: string[];
  };
  sections: {
    [key: string]: {
      score: number;
      roast: string;
    };
  };
  faang_attack_vectors: Array<{
    trigger_claim: string;
    attack_question: string;
  }>;
  resume_text?: string;
  code?: string;
  repo_url?: string | null;
  job_description?: string;
  has_github?: boolean;
  github_error?: string | null;
  repository_coverage?: RepositoryCoverage;
  evidence_checks?: EvidenceCheck[];
}

interface ApiResponse {
  status: string;
  data: string;
  initial_chat: string;
}

const LOCAL_CACHE = new Map<string, RoastData>();

// ─────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────
const PROCESSING_MESSAGES = [
  "Warming up the interrogator. Please don't cry.",
  "Calculating your Combat Readiness Score... this might hurt.",
  "Preparing FAANG-grade attack vectors. Brace yourself.",
  "Auditing your project. We hope you practiced your defense.",
] as const;

const MAX_FILE_SIZE_MB = 10;
const API_URL = `${process.env.NEXT_PUBLIC_BACKEND_URL || "https://sparta-1l4n.onrender.com"}/analyze`;

// ─────────────────────────────────────────────────
// useCountUp Hook
// ─────────────────────────────────────────────────
function useCountUp(target: number, duration: number = 1500): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (target === 0) return;
    let startTime: number | null = null;
    const startValue = 0;

    const step = (timestamp: number) => {
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.round(startValue + (target - startValue) * eased));
      if (progress < 1) requestAnimationFrame(step);
    };

    const raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return count;
}

// ─────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────
function scoreColor(score: number): string {
  if (score < 50) return "text-danger";
  if (score < 70) return "text-warning";
  return "text-brand";
}

function scoreBarColor(score: number): string {
  if (score < 50) return "bg-danger";
  if (score < 70) return "bg-warning";
  return "bg-accent";
}

function scoreBadgeLabel(score: number): string {
  if (score < 30) return "CATASTROPHIC";
  if (score < 50) return "FAILING";
  if (score < 70) return "MEDIOCRE";
  if (score < 85) return "ADEQUATE";
  return "EXCEPTIONAL";
}

function scoreBadgeColor(score: number): string {
  if (score < 30) return "bg-danger-soft text-danger border-danger/20";
  if (score < 50) return "bg-warning-soft text-warning border-warning/20";
  if (score < 70) return "bg-warning-soft text-warning border-warning/20";
  if (score < 85) return "bg-info-soft text-info border-info/20";
  return "bg-accent-soft text-brand border-line";
}

const SECTION_ICONS: Record<keyof RoastSections, React.ElementType> = {
  experience: Briefcase,
  skills: Code2,
  formatting: BarChart2,
  ats_compatibility: Shield,
};

const SECTION_LABELS: Record<keyof RoastSections, string> = {
  experience: "Experience",
  skills: "Skills",
  formatting: "Formatting",
  ats_compatibility: "ATS Compatibility",
};

const SECTION_KEYS = [
  "experience",
  "skills",
  "formatting",
  "ats_compatibility",
] as const;

// ─────────────────────────────────────────────────
// Cycling Text Component
// ─────────────────────────────────────────────────
function CyclingText() {
  return (
    <p role="status" className="w-full max-w-xl text-center text-sm font-mono text-muted tracking-wide">
      <TypewriterText lines={PROCESSING_MESSAGES} />
    </p>
  );
}

// ─────────────────────────────────────────────────
// Skeleton Dashboard
// ─────────────────────────────────────────────────
function SkeletonDashboard() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="w-full max-w-5xl mx-auto"
    >
      <div className="flex gap-4 w-full h-[480px]">
        <div className="w-2/5 h-full rounded-none bg-tint animate-pulse" />
        <div className="flex-1 flex flex-col gap-4">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="flex-1 rounded-none bg-tint animate-pulse"
              style={{ animationDelay: `${i * 100}ms` }}
            />
          ))}
        </div>
      </div>
      <div className="mt-8 flex flex-col items-center gap-3">
        <div className="w-48 h-[2px] bg-line rounded-none overflow-hidden">
          <motion.div
            className="h-full bg-surface rounded-none"
            animate={{ x: ["-100%", "200%"] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
          />
        </div>
        <CyclingText />
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────
// Score Ring SVG
// ─────────────────────────────────────────────────
function ScoreRing({ score }: { score: number }) {
  const animated = useCountUp(score, 1500);
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  const ringColor =
    score < 50 ? "var(--color-danger)" : score < 70 ? "var(--color-warning)" : "var(--color-accent)";

  return (
    <div className="relative flex items-center justify-center w-36 h-36 mx-auto">
      <svg
        className="absolute inset-0 -rotate-90"
        width="144"
        height="144"
        viewBox="0 0 144 144"
      >
        {/* Track */}
        <circle
          cx="72"
          cy="72"
          r={radius}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth="10"
        />
        {/* Progress */}
        <circle
          cx="72"
          cy="72"
          r={radius}
          fill="none"
          stroke={ringColor}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 1.5s cubic-bezier(0.22,1,0.36,1)" }}
        />
      </svg>
      <div className="relative flex flex-col items-center">
        <span className={`text-3xl font-bold tabular-nums ${scoreColor(score)}`}>
          {animated}
        </span>
        <span className="text-xs text-muted font-sans">/100</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────
// Section Card (collapsible)
// ─────────────────────────────────────────────────
interface SectionCardProps {
  sectionKey: keyof RoastSections;
  data: SectionData;
  delay: number;
  visible: boolean;
}

function SectionCard({ sectionKey, data, delay, visible }: SectionCardProps) {
  const [open, setOpen] = useState(sectionKey === "experience" || sectionKey === "skills");
  const [barWidth, setBarWidth] = useState("0%");

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => setBarWidth(`${data.score}%`), delay + 200);
    return () => clearTimeout(t);
  }, [visible, data.score, delay]);

  const handleToggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div
      className="review-section bg-surface border border-line rounded-2xl p-5 mb-3 hover:border-brand transition-colors duration-200 cursor-pointer select-none"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(16px)",
        transition: `opacity 0.4s ease ${delay}ms, transform 0.4s ease ${delay}ms`,
      }}
      onClick={handleToggle}
      role="button"
      aria-expanded={open}
    >
      {/* Header Row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span className={`${scoreColor(data.score)}`}>
            {(() => {
              const IconComp = SECTION_ICONS[sectionKey];
              return <IconComp className="w-4 h-4" />;
            })()}
          </span>
          <span className="text-sm font-bold text-ink">
            {SECTION_LABELS[sectionKey]}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`text-xs font-bold px-2 py-0.5 rounded-none border font-sans ${scoreColor(data.score)} bg-surface border-line`}
          >
            {data.score}
          </span>
          <span className="text-muted text-xs">{open ? "▲" : "▼"}</span>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="h-[3px] bg-line rounded-none overflow-hidden mb-3">
        <div
          className={`h-full rounded-none ${scoreBarColor(data.score)}`}
          style={{
            width: barWidth,
            transition: "width 1s cubic-bezier(0.22,1,0.36,1)",
          }}
        />
      </div>

      {/* Collapsible Roast Text */}
      <AnimatePresence>
        {open && (
          <motion.p
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
            className="text-sm text-copy leading-relaxed overflow-hidden"
          >
            {data.roast}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────────────────────────────
// Sticky Nav Bar
// ─────────────────────────────────────────────────
function StickyNav({ onReset }: { onReset?: () => void }) {
  const [time, setTime] = useState("");

  useEffect(() => {
    const update = () => setTime(new Date().toLocaleTimeString());
    update();
    const i = setInterval(update, 1000);
    return () => clearInterval(i);
  }, []);

  return (
    <div className="sticky top-0 z-50 bg-surface border-b-2 border-line">
      <div className="max-w-7xl mx-auto px-5 sm:px-8 min-h-20 sm:min-h-22 py-2.5 flex items-center justify-between">
        {/* Left */}
        {onReset ? (
          <button
            onClick={onReset}
            className="plain-button flex items-center gap-3.5 cursor-pointer hover:opacity-80 transition-opacity group focus:outline-none bg-transparent border-0 !border-none shadow-none !shadow-none p-0"
            title="Return to Home"
          >
            <SpartaLogo />
            <span className="text-2xl sm:text-3xl font-black tracking-[0.14em] text-ink uppercase group-hover:text-brand transition-colors">
              S.P.A.R.T.A.
            </span>
          </button>
        ) : (
          <div className="flex items-center gap-3.5">
            <SpartaLogo />
            <span className="text-2xl sm:text-3xl font-black tracking-[0.14em] text-ink uppercase">
              S.P.A.R.T.A.
            </span>
          </div>
        )}

        {/* Center */}
        <div className="hidden sm:flex items-center gap-2 border border-line bg-secondary-soft text-secondary px-3 py-1.5 rounded-none">
          <CheckCircle className="w-4 h-4 text-brand" />
          <span className="text-xs text-secondary font-mono font-medium">
            Review complete
          </span>
        </div>

        {/* Right */}
        <div className="flex items-center gap-4">
          <ThemeToggle />
          {onReset && (
            <button
              onClick={onReset}
              className="flex items-center gap-2 px-3 py-1.5 rounded-none bg-tint border border-line hover:border-brand text-xs font-sans text-copy hover:text-brand transition-all shadow-none cursor-pointer"
            >
              <RefreshCcw className="w-3.5 h-3.5 text-brand" />
              <span>Return Home</span>
            </button>
          )}
          <div className="hidden sm:flex items-center gap-2 text-muted text-xs font-sans">
            <Clock className="w-3.5 h-3.5" />
            <span>{time}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────
// Roast Dashboard
// ─────────────────────────────────────────────────
function RoastDashboard({
  roastData,
  uploadedFile,
  onReset,
  onInterviewStart,
  setAppState,
}: {
  roastData: RoastData;
  uploadedFile: File | null;
  onReset: () => void;
  onInterviewStart: () => void;
  setAppState: (state: any) => void;
}) {
  const [cardsVisible, setCardsVisible] = useState(false);
  const [rippling, setRippling] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!uploadedFile) return;
    const url = URL.createObjectURL(uploadedFile);
    setPdfUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [uploadedFile]);

  useEffect(() => {
    const t = setTimeout(() => setCardsVisible(true), 200);
    return () => clearTimeout(t);
  }, []);

  const handleVoice = useCallback(() => {
    setRippling(true);
    setTimeout(() => {
      setRippling(false);
      onInterviewStart();
    }, 600);
  }, [onInterviewStart]);

  return (
    <>
      <StickyNav onReset={onReset} />
      <div
        className="review-page max-w-7xl mx-auto w-full px-5 sm:px-8 py-8 opacity-0 animate-[fadeIn_0.7s_ease_forwards]"
        style={{ animationFillMode: "forwards" }}
      >
        <style>{`
          @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
          @keyframes ripple { 0% { transform: scale(0); opacity: 0.6; } 100% { transform: scale(3); opacity: 0; } }
          .ripple-circle { animation: ripple 0.6s ease-out forwards; }
        `}</style>

        {roastData.github_error && (
          <p role="status" className="mb-6 border border-warning/30 bg-warning-soft p-4 text-sm text-warning">
            GitHub evidence was unavailable: {roastData.github_error} This review and interview will use resume claims only.
          </p>
        )}
        <EvidenceNotice coverage={roastData.repository_coverage} checks={roastData.evidence_checks} hasGithub={roastData.has_github} />
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-7">
          {/* ── Left Column: PDF Panel ── */}
          <div className="lg:col-span-6 lg:sticky lg:top-24 self-start">
            <div className="bg-surface border border-line rounded-2xl min-h-[460px] lg:min-h-[720px] p-4 flex flex-col">
              {/* Panel header */}
              <div className="flex items-center gap-2 mb-4">
                <FileText className="w-4 h-4 text-muted" />
                <span className="text-xs font-sans text-muted tracking-wide uppercase">
                  Resume PDF
                </span>
              </div>

              {pdfUrl ? (
                // Real PDF viewer
                <iframe
                  src={pdfUrl}
                  className="w-full h-full rounded-none min-h-[420px] lg:min-h-[660px] border border-line bg-tint flex-1"
                  title="Resume Preview"
                />
              ) : (
                // Keep the original shimmer skeleton as fallback
                // when no file is available
                <div className="flex-1 p-6 flex flex-col gap-4">
                  {[...Array(3)].map((_, blockIdx) => (
                    <div key={blockIdx} className="space-y-2">
                      <div className="h-3 w-1/3 rounded-none bg-line animate-pulse" />
                      {[...Array(4)].map((_, lineIdx) => (
                        <div
                          key={lineIdx}
                          className="h-2 rounded-none bg-line animate-pulse"
                          style={{
                            width: `${70 + Math.random() * 25}%`,
                            animationDelay: `${(blockIdx * 4 + lineIdx) * 80}ms`,
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Right Column: Roast Analysis ── */}
          <div className="lg:col-span-6">
            <div className="mb-5">
              <h1 className="text-3xl font-bold tracking-[-0.04em] text-ink">Your resume review</h1>
              <p className="mt-1 text-sm text-muted">Understand your strengths and choose what to improve next.</p>
            </div>
            {/* Score Header Card */}
            <div className="review-score bg-surface border border-line rounded-2xl p-6 mb-4">
              <div className="flex flex-col items-center">
                <span className="text-[11px] font-mono font-medium text-muted uppercase tracking-wide mb-4">
                  Resume readiness
                </span>
                <ScoreRing score={roastData.combat_readiness_score} />
              </div>

              <div className="text-center mt-4 space-y-3">
                <span
                  className={`inline-block px-3 py-1 rounded-none border text-xs font-bold tracking-wide ${scoreBadgeColor(roastData.combat_readiness_score)}`}
                >
                  {scoreBadgeLabel(roastData.combat_readiness_score)}
                </span>
                <p className="text-ink text-2xl font-bold leading-snug">
                  {roastData.verdict}
                </p>
              </div>
            </div>

            {/* ── ATS METRICS SECTION ── */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              {/* Match Rate */}
              <div className="metric-card bg-secondary-soft border border-line rounded-2xl p-5 flex flex-col justify-center">
                <span className="text-xs font-bold text-muted uppercase tracking-wide mb-1">Keyword Match</span>
                <span className="text-3xl font-mono font-bold tracking-tight text-ink">{roastData.ats_metrics.keyword_match_rate}%</span>
              </div>

              {/* Quantification Rate */}
              <div className="metric-card bg-accent-soft border border-line rounded-2xl p-5 flex flex-col justify-center">
                <span className="text-xs font-bold text-muted uppercase tracking-wide mb-1">Quantification</span>
                <span className="text-3xl font-mono font-bold tracking-tight text-ink">{roastData.ats_metrics.quantification_rate}%</span>
              </div>
            </div>

            {/* Missing Skills Badges */}
            {roastData.ats_metrics.missing_critical_skills.length > 0 && (
              <div className="mb-8">
                <h3 className="text-xs font-bold text-muted uppercase tracking-wide mb-3">Skills to strengthen</h3>
                <div className="flex flex-wrap gap-2">
                  {roastData.ats_metrics.missing_critical_skills.map((skill, idx) => (
                    <span key={idx} className="bg-danger-soft text-danger border border-danger/30 rounded-none px-3 py-1 text-xs font-sans">
                      {skill}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Section Cards */}
            <div>
              {SECTION_KEYS.map((key, i) => (
                <SectionCard
                  key={key}
                  sectionKey={key}
                  data={roastData.sections[key]}
                  delay={i * 100}
                  visible={cardsVisible}
                />
              ))}
            </div>

            {/* ── FAANG ATTACK VECTORS ── */}
            {roastData.faang_attack_vectors && roastData.faang_attack_vectors.length > 0 && (
              <div className="mt-8 mb-6">
                <h3 className="text-xs font-bold text-muted uppercase tracking-wide mb-4 flex items-center gap-2">
                  <AlertTriangle size={14} className="text-warning" />
                  Questions to prepare for
                </h3>

                <div className="space-y-3">
                  {roastData.faang_attack_vectors.map((vector, idx) => (
                    <div key={idx} className="bg-tint border border-line border-l-2 border-l-warning rounded-none p-4">
                      <p className="text-xs text-muted font-sans mb-2">Claim Detected: "{vector.trigger_claim}"</p>
                      <p className="text-sm text-copy font-medium leading-relaxed">{vector.attack_question}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* CTA: Voice Interrogation */}
            <div
              className="mb-4"
              style={{
                opacity: cardsVisible ? 1 : 0,
                transform: cardsVisible ? "translateY(0)" : "translateY(16px)",
                transition: "opacity 0.4s ease 600ms, transform 0.4s ease 600ms",
              }}
            >
              <div className="flex flex-col sm:flex-row items-center gap-4 mt-8 w-full">
                <button
                  onClick={() => {
                    sessionStorage.setItem("sparta_roast_data", JSON.stringify(roastData));
                    sessionStorage.setItem("sparta_resume_text", roastData.resume_text || "");
                    window.location.href = "/interrogation";
                  }}
                  className="flex-1 px-6 py-3.5 bg-surface hover:bg-tint border border-line hover:border-line text-brand font-bold rounded-none transition-all flex justify-center items-center gap-2"
                >
                  <Mic size={18} /> Practise an interview
                </button>

                <button
                  onClick={() => setAppState("rebuild")}
                  className="flex-1 px-6 py-3.5 bg-accent hover:bg-accent-hover text-on-accent font-bold rounded-none transition-all flex justify-center items-center gap-2 shadow-none"
                >
                  <Wrench size={18} /> Refine resume bullets
                </button>
              </div>
            </div>

            {/* Reset */}
            <button
              onClick={onReset}
              className="w-full text-xs text-muted hover:text-brand transition-colors duration-150 py-2"
            >
              Analyze another resume
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────
// Voice Modal Simulator
// ─────────────────────────────────────────────────
const VoiceModal = ({
  roastData,
  onClose
}: {
  roastData: RoastData;
  onClose: () => void
}) => {
  const [isMuted, setIsMuted] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [containerHeight, setContainerHeight] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const audioPlayer = useRef<HTMLAudioElement | null>(null);
  const [userTranscript, setUserTranscript] = useState("");
  const { start: startMicrophone, stop: finishRecording, isListening, isConnecting, isFinishing, error: microphoneError } = useSpeechRecorder(setUserTranscript);

  const [chatHistory, setChatHistory] = useState<{type: string, text: string}[]>([]);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);

  // The first Attack Vector is our starting context
  const attackContext = roastData.faang_attack_vectors?.[0];

  const stopMicrophone = async () => {
    const answer = await finishRecording();
    if (answer) triggerAiResponse(answer);
  };

  const triggerAiResponse = async (userMessage: string) => {
    setIsAiSpeaking(true);
    setTranscript("");

    try {
      const res = await axios.post("/api/interrogation", {
        message: userMessage,
        history: chatHistory,
        context: JSON.stringify(roastData),
      });

      // Safely extract the response directly matching FastAPI's {response: ...} structure
      const replyText = res.data.response || res.data.reply || (typeof res.data === 'string' ? res.data : JSON.stringify(res.data));

      const words = replyText.toString().split(" ");
      let audioPlayed = false;

      // -- FETCH TTS FROM DEEPGRAM AURA & SYNC TEXT TO AUDIO --
      try {
        const tokenRes = await fetch("/api/deepgram");
        const tokenData = await tokenRes.json();
        if (tokenData.key) {
          const audioRes = await fetch("https://api.deepgram.com/v1/speak?model=aura-athena-en", {
            method: "POST",
            headers: {
              "Authorization": `Token ${tokenData.key}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ text: replyText.toString() })
          });
          const audioBlob = await audioRes.blob();
          if (audioBlob && audioBlob.size > 100 && audioPlayer.current) {
            const audioUrl = URL.createObjectURL(audioBlob);
            try {
              audioPlayer.current.pause();
            } catch (e) {}

            audioPlayer.current.src = audioUrl;

            // Audio-synced text reveal handler
            audioPlayer.current.ontimeupdate = () => {
              if (audioPlayer.current && audioPlayer.current.duration > 0) {
                const progress = audioPlayer.current.currentTime / audioPlayer.current.duration;
                const wordIndex = Math.min(words.length, Math.floor(progress * words.length) + 1);
                setTranscript(words.slice(0, wordIndex).join(" "));
              }
            };

            audioPlayer.current.onended = () => {
              setTranscript(replyText.toString());
              setIsAiSpeaking(false);
              setChatHistory((prev) => [
                ...prev,
                { type: "user", text: userMessage },
                { type: "model", text: replyText.toString() }
              ]);
            };

            try {
              await audioPlayer.current.play();
              audioPlayed = true;
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

      // Fallback typewriter interval if audio isn't supported or fails
      if (!audioPlayed) {
        let currentText = "";
        let i = 0;
        const interval = setInterval(() => {
          if (i < words.length) {
            currentText += (i > 0 ? " " : "") + words[i];
            setTranscript(currentText);
            i++;
          } else {
            clearInterval(interval);
            setIsAiSpeaking(false);
            setChatHistory((prev) => [
              ...prev,
              { type: "user", text: userMessage },
              { type: "model", text: replyText.toString() }
            ]);
          }
        }, 150);
      }

    } catch (e) {
      console.error(e);
      const detail = axios.isAxiosError(e) ? e.response?.data?.error : undefined;
      setTranscript(typeof detail === "string" ? detail : "SYS_ERR: Connection lost to S.P.A.R.T.A. main node. Ensure the backend is running.");
      setIsAiSpeaking(false);
    }
  };

  useEffect(() => {
    if (attackContext) {
      const initPrompt = `Start the interrogation using this context: the user claimed "${attackContext.trigger_claim}". Your objective is to brutally question them on this: "${attackContext.attack_question}". Ask the first question.`;
      triggerAiResponse(initPrompt);
    }
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript, userTranscript]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-overlay "
    >
      <div className="w-full max-w-6xl bg-surface border border-line rounded-none shadow-none flex flex-col overflow-hidden h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-line bg-surface">
          <div className="flex items-center gap-3">
            <div className="relative flex items-center justify-center w-10 h-10 rounded-none bg-tint border border-line">
              <Activity className="text-danger animate-pulse" size={18} />
              {/* Outer pulsing ring */}
              <div className="absolute inset-0 rounded-none border border-danger/20 hidden"></div>
            </div>
            <div>
              <h2 className="text-ink font-bold tracking-wide uppercase text-sm">S.P.A.R.T.A. Engine</h2>
              <p className="text-danger text-xs font-sans uppercase">Live Interrogation</p>
            </div>
          </div>
          <div className="text-muted font-sans text-xs animate-pulse">
            REC 00:00:14
          </div>
        </div>

        {/* Main Body */}
        <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden">

          {/* Left: Context Panel */}
          <div className="lg:w-1/3 border-b lg:border-b-0 lg:border-r border-line p-6 bg-tint flex flex-col gap-4">
            <h3 className="text-xs font-bold text-muted uppercase tracking-wide mb-2">Current Attack Vector</h3>
            <div className="bg-tint border border-line rounded-none p-4">
              <p className="text-xs text-muted font-sans mb-2">Trigger Claim:</p>
              <p className="text-sm text-copy">"{attackContext?.trigger_claim || 'Parsing resume...'}"</p>
            </div>
            <div className="bg-danger-soft border border-danger/20 rounded-none p-4">
              <p className="text-xs text-danger font-sans mb-2">Objective:</p>
              <p className="text-sm text-danger">Test depth of technical implementation. Do not accept high-level buzzwords.</p>
            </div>
          </div>

          {/* Right: Transcript Window */}
          <div className="flex-1 p-6 flex flex-col relative bg-surface min-w-0 min-h-0">
            <div className="absolute inset-0 bg-gradient-to-b from-surface via-transparent to-transparent z-10 pointer-events-none h-24"></div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto pb-24 scrollbar-hide flex flex-col justify-start">
              <AnimatePresence>
                {userTranscript && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="flex items-start gap-4 mb-8 self-end"
                  >
                    <div className="text-xl text-muted font-medium leading-relaxed max-w-2xl text-right">
                      {userTranscript}
                      {isListening && <span className="inline-block w-2 h-5 bg-muted ml-2 animate-pulse"></span>}
                    </div>
                    <div className="w-8 h-8 rounded-none bg-tint border border-line text-muted flex items-center justify-center font-bold text-xs flex-shrink-0">
                      YOU
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="flex items-start gap-4 mb-6">
                <div className="w-8 h-8 rounded-none bg-surface text-ink flex items-center justify-center font-bold text-xs flex-shrink-0">
                  AI
                </div>
                {/* PRETEXT DRIVEN CONTAINER */}
                <div
                  className="text-2xl text-ink font-light leading-relaxed max-w-2xl"
                  style={{ minHeight: containerHeight > 0 ? `${containerHeight}px` : 'auto' }}
                >
                  {transcript}
                  <span className="inline-block w-2 h-6 bg-danger ml-2 animate-pulse"></span>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* Footer Controls */}
        {microphoneError && <p role="alert" className="mx-6 mb-3 border border-danger/30 bg-danger-soft p-3 text-sm text-danger">{microphoneError}</p>}
        <p role="status" className="px-6 text-center text-xs text-muted">
          {isConnecting ? "Connecting microphone…" : isFinishing ? "Finishing transcription…" : isListening ? "Microphone is recording. Speak, then stop to send your answer." : "Tap the microphone to speak."}
        </p>
        <div className="p-6 border-t border-line bg-surface flex items-center justify-center gap-4 relative">
          <audio ref={audioPlayer} className="hidden" />

          <button
            onClick={isListening ? stopMicrophone : startMicrophone}
            disabled={isConnecting || isFinishing}
            aria-label={isConnecting ? "Connecting microphone" : isFinishing ? "Finishing transcription" : isListening ? "Stop recording and send answer" : "Start recording"}
            className={`p-4 rounded-none transition-all duration-300 border ${
              isListening
                ? 'bg-danger-soft border-danger text-danger shadow-none animate-pulse'
                : 'bg-tint border-line text-ink hover:bg-surface'
            }`}
          >
            {isListening ? <MicOff size={20} /> : <Mic size={20} />}
          </button>

          <button
            onClick={onClose}
            className="px-8 py-4 bg-brand hover:bg-brand-hover text-on-brand font-bold rounded-none transition-colors flex items-center gap-2"
          >
            <PhoneOff size={18} />
            End Interrogation
          </button>
        </div>
      </div>
    </motion.div>
  );
};

const RebuildModal = ({ onClose, rawResumeText, uploadedFile }: { onClose: () => void, rawResumeText: string, uploadedFile: File | null }) => {
  const [isGenerating, setIsGenerating] = useState(true);
  const [diffs, setDiffs] = useState<{original: string, enhanced: string}[]>([]);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [selectedBullets, setSelectedBullets] = useState<boolean[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const generateDiffs = async () => {
    setIsGenerating(true);
    setGenerationError(null);
    setSaveError(null);
    try {
      if (!rawResumeText.trim()) {
        throw new Error("Resume text is missing. Analyze your resume again before reconstruction.");
      }
      const res = await fetch("/api/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeText: rawResumeText, mode: "resume" }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Resume reconstruction failed. Please retry.");
      }
      if (!Array.isArray(data.bullets) || !data.bullets.length || data.bullets.some(
        (bullet: {original?: unknown; enhanced?: unknown} | null) => !bullet ||
          typeof bullet.original !== "string" || typeof bullet.enhanced !== "string"
      )) {
        throw new Error("The server returned an invalid resume rewrite. Please retry.");
      }
      setDiffs(data.bullets);
      setSelectedBullets(data.bullets.map(() => true));
    } catch (e) {
      setDiffs([]);
      setGenerationError(e instanceof Error ? e.message : "Resume reconstruction failed. Please retry.");
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    generateDiffs();
  }, []);

  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const selectedTexts = diffs.filter((_, index) => selectedBullets[index]).map(diff => diff.enhanced.trim());
  const needsReview = selectedTexts.some(text => !text || /🔴|\[(?:add|insert|verify|replace|your)\b/i.test(text));

  const savePdfCopy = async () => {
    if (!uploadedFile || !selectedTexts.length || needsReview) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const body = new FormData();
      body.append("file", uploadedFile);
      body.append("bullets", JSON.stringify(diffs.filter((_, index) => selectedBullets[index]).map(diff => ({ original: diff.original, enhanced: diff.enhanced.trim() }))));
      const response = await fetch("/api/export-resume", { method: "POST", body });
      if (!response.ok) {
        const failure = await response.json();
        throw new Error(failure.error || "Could not save the PDF. Please retry.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${uploadedFile.name.replace(/\.pdf$/i, "")}-reconstructed.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save the PDF. Please retry.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-overlay "
    >
      <div className="w-full max-w-4xl bg-surface border border-line rounded-xl shadow-none flex flex-col h-[85vh] overflow-hidden">
        <div className="flex items-center justify-between p-6 border-b border-line bg-surface">
          <div>
            <h2 className="text-ink font-bold tracking-tight text-lg">Resume reconstruction</h2>
            <p className="text-muted text-xs font-mono mt-1">Review, edit, and save your improvements</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close resume reconstruction" className="close-button inline-flex h-9 w-9 shrink-0 items-center justify-center text-muted hover:text-ink transition-colors">✕</button>
        </div>

        <div className="flex-1 p-6 overflow-y-auto bg-surface space-y-8">
          {isGenerating ? (
             <div className="h-full flex flex-col items-center justify-center gap-4 text-muted">
                <Wrench className="animate-spin text-brand" size={24} />
                <p className="animate-pulse font-sans text-sm">Preparing your resume suggestions…</p>
             </div>
          ) : generationError ? (
            <p role="alert" className="text-sm text-danger">{generationError}</p>
          ) : (
            (diffs || []).map((diff, idx) => (
              <div key={idx} className="flex flex-col gap-2">
                {/* BEFORE block */}
                <div className="p-4 bg-tint border border-line rounded-none">
                  <span className="text-xs font-sans text-muted uppercase block mb-2">Original bullet</span>
                  <p className="text-sm text-muted ">{diff.original}</p>
                </div>

                {/* AFTER block */}
                <div className="p-5 pt-14 bg-surface border border-line border-l-4 border-l-secondary rounded-none relative group">
                  <label className="flex items-center gap-2 text-xs font-sans text-brand uppercase mb-3">
                    <input type="checkbox" checked={!!selectedBullets[idx]} disabled={isSaving}
                      aria-label={`Include bullet ${idx + 1} in PDF`}
                      onChange={event => setSelectedBullets(previous => previous.map((selected, index) => index === idx ? event.target.checked : selected))} />
                    Include in PDF copy
                  </label>
                  <label className="block text-xs text-muted mb-2" htmlFor={`rewrite-${idx}`}>Edit and verify this bullet before saving</label>
                  <textarea id={`rewrite-${idx}`} aria-label={`Edit reconstructed bullet ${idx + 1}`} value={diff.enhanced}
                    disabled={isSaving} maxLength={5000} rows={4}
                    onChange={event => setDiffs(previous => previous.map((item, index) => index === idx ? { ...item, enhanced: event.target.value } : item))}
                    className="w-full rounded-none border border-line bg-surface p-3 text-sm text-copy focus:border-brand focus:outline-none" />
                  {/* Pretext layout injection for smooth rendering */}
                  <div className="text-sm text-copy font-sans leading-relaxed mt-4">
                    {diff.enhanced.split(/(🔴\[.*?\])/g).map((part, partIndex) =>
                      part.startsWith("🔴[") ? (
                        <span key={partIndex} className="text-danger bg-danger-soft px-1 rounded-none">{part.slice(2)}</span>
                      ) : part
                    )}
                  </div>

                  <div className="absolute top-4 right-4 opacity-100 transition-opacity flex gap-2">
                    <button onClick={() => handleCopy(diff.enhanced, idx)} className="px-3 py-1 bg-surface border border-line hover:border-brand rounded-none text-xs text-copy transition-colors flex items-center gap-2">
                      {copiedIndex === idx ? <CheckCircle2 size={12} className="text-brand"/> : <Copy size={12}/>}
                      {copiedIndex === idx ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Action Footer */}
        {!isGenerating && (
          <div className="p-4 border-t border-line bg-surface space-y-3">
            <p className="text-xs text-muted">Selected bullets replace their original text in the PDF copy. No extra page is added. Shorten any bullet that cannot fit.</p>
            {needsReview && <p role="alert" className="text-xs text-warning">Fill marked placeholders and empty bullets, or deselect them before saving.</p>}
            {saveError && <p role="alert" className="text-sm text-danger">{saveError}</p>}
            <div className="flex flex-wrap justify-end gap-3">
            <button onClick={generateDiffs} disabled={isSaving} className="px-4 py-2 flex items-center gap-2 text-sm text-muted hover:text-ink transition-colors disabled:opacity-50">
              <RefreshCcw size={14} /> Regenerate All
            </button>
            <button onClick={savePdfCopy} disabled={isSaving || !uploadedFile || !selectedTexts.length || needsReview || !!generationError}
              className="rounded-none bg-accent hover:bg-accent-hover px-4 py-2 text-sm font-bold text-on-accent transition-colors disabled:opacity-40">
              {isSaving ? "Saving PDF..." : `Save PDF copy (${selectedTexts.length})`}
            </button>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
};

// ─────────────────────────────────────────────────
// Main Page Component
// ─────────────────────────────────────────────────
export default function HomePage() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [isDragOver, setIsDragOver] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [roastData, setRoastData] = useState<RoastData | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [jobDescription, setJobDescription] = useState<string>("");
  const [jdError, setJdError] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── File Validation ──────────────────────────
  const validateFile = (file: File): string | null => {
    if (file.type !== "application/pdf") {
      return "Invalid file type. Please upload a PDF.";
    }
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      return `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`;
    }
    return null;
  };

  // ── API Call ─────────────────────────────────
  const processFile = useCallback(async (file: File) => {
    // Gate 1: JD must not be empty or just whitespace
    if (!jobDescription.trim()) {
      setJdError(true);
      setTimeout(() => setJdError(false), 3000);
      return;
    }

    const validationError = validateFile(file);
    if (validationError) {
      setErrorMessage(validationError);
      setAppState("error");
      return;
    }

    const fileCacheKey = `${file.name}-${file.size}-${file.lastModified}-${jobDescription.trim()}`;
    const cachedData = LOCAL_CACHE.get(fileCacheKey);

    if (cachedData) {
      console.log("⚡ Cache hit for:", file.name);
      setUploadedFile(file);
      setRoastData(cachedData);
      setAppState("done");
      return;
    }

    setAppState("processing");
    setErrorMessage(null);
    setRoastData(null);
    setUploadedFile(file);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("job_description", jobDescription.trim());

    try {
      const response = await axios.post<ApiResponse>(API_URL, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      if (response.data.status === "error" || (response.data as any).detail) {
        const errorDetail = (response.data as any).detail || (response.data as any).message || "Document rejected. Please upload a valid resume PDF.";
        setErrorMessage(errorDetail);
        setAppState("error");
        return;
      }

      const parsedData = typeof response.data.data === "string"
        ? JSON.parse(response.data.data)
        : response.data.data;

      if (!parsedData || !parsedData.sections) {
        setErrorMessage("This document does not appear to be a valid resume. Please upload a valid resume PDF.");
        setAppState("error");
        return;
      }

      if (!parsedData.github_error) LOCAL_CACHE.set(fileCacheKey, parsedData as RoastData);
      setRoastData(parsedData as RoastData);
      setAppState("done");
    } catch (err: unknown) {
      console.error("❌ API Error:", err);
      const message =
        axios.isAxiosError(err) && err.response?.data?.detail
          ? err.response.data.detail
          : "Could not connect to the S.P.A.R.T.A. backend. Is it running?";
      setErrorMessage(message);
      setAppState("error");
    }
  }, [jobDescription]);

  // ── Drag & Drop Handlers ─────────────────────
  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      if (!jobDescription.trim()) {
        setJdError(true);
        setTimeout(() => setJdError(false), 3000);
        return;
      }
      processFile(file);
    },
    [jobDescription, processFile]
  );

  // ── Click to Upload ──────────────────────────
  const handleClick = useCallback(() => {
    if (appState === "idle" || appState === "error") {
      if (!jobDescription.trim()) {
        setJdError(true);
        setTimeout(() => setJdError(false), 3000);
        return;
      }
      fileInputRef.current?.click();
    }
  }, [appState, jobDescription]);

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
      e.target.value = "";
    },
    [processFile]
  );

  const handleReset = useCallback(() => {
    setAppState("idle");
    setErrorMessage(null);
    setRoastData(null);
    setUploadedFile(null);
    setJobDescription("");
    setJdError(false);
  }, []);

// ── Render: Dashboard ────────────────────────
  if ((appState === "done" || appState === "interview" || appState === "rebuild") && roastData) {
    const parsedResumeData = { text: "" }; // Fallback to prevent ReferenceError since it's not defined originally
    return (
      <>
        <RoastDashboard
          roastData={roastData}
          uploadedFile={uploadedFile}
          onReset={handleReset}
          onInterviewStart={() => setAppState("interview")}
          setAppState={setAppState}
        />
        <AnimatePresence>
          {appState === "interview" && (
            <VoiceModal
              roastData={roastData}
              onClose={() => setAppState("done")}
            />
          )}
          {appState === "rebuild" && (
            <RebuildModal
              uploadedFile={uploadedFile}
              rawResumeText={(roastData as any)?.resume_text || ""}
              onClose={() => setAppState("done")}
            />
          )}
        </AnimatePresence>
      </>
    );
  }

  // ── Render: Upload / Processing / Error ──────
  return (
    <main className="upload-page min-h-screen bg-canvas text-ink flex flex-col items-center px-5 sm:px-8 relative">
      {/* Background grid */}
      <div
        className="hidden"
        style={{
          backgroundImage:
            "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />

      {/* Header */}
      <div className="relative z-20 w-full max-w-6xl flex items-center justify-between gap-4 pt-6">
        <motion.div
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="upload-brand flex items-center gap-3"
        >
          <SpartaLogo />
          <span className="text-2xl sm:text-3xl font-black tracking-[0.14em] text-ink uppercase">
            S.P.A.R.T.A.
          </span>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="flex items-center gap-4 text-xs text-muted"
        >
          <span className="hidden md:inline bg-secondary-soft text-secondary border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-wide">Resume & interview preparation</span>
          <ThemeToggle />
        </motion.div>
      </div>

      {/* Main content */}
      <div className="relative z-10 w-full max-w-6xl flex flex-col items-center gap-6 sm:gap-8 pt-8 pb-4">
        <AnimatePresence mode="wait">
          {appState !== "processing" && (
            <motion.div
              key="title"
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.5 }}
              className="upload-hero w-full border-t-2 border-line pt-5 sm:pt-6"
            >
              <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                Resume review / Interview preparation
              </p>
              <div className="flex flex-col gap-5">
                <TypewriterHeading />
                <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 sm:gap-8">
                  <p className="max-w-xl text-sm sm:text-base text-copy leading-relaxed">
                    Match your resume to the role. Refine your bullet points.
                    Practise the questions that follow.
                  </p>
                  <p className="shrink-0 font-mono text-[10px] lg:text-[11px] uppercase tracking-[0.1em] text-muted">
                    01 Upload &nbsp; / &nbsp; 02 Review &nbsp; / &nbsp; 03 Prepare
                  </p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Drop Zone / Skeleton */}
        <AnimatePresence mode="wait">
          {appState === "idle" || appState === "error" ? (
            <motion.div
              key="dropzone"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.35 }}
              className="upload-workspace w-full grid grid-cols-1 md:grid-cols-[1.15fr_1fr] border border-line"
            >
              <motion.div
                onClick={handleClick}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                animate={{
                  scale: 1,
                  borderColor: isDragOver
                    ? "var(--color-brand)"
                    : "var(--color-line)",
                  boxShadow: isDragOver
                    ? "inset 0 0 0 2px var(--color-line)"
                    : "none",
                }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className={`
                  upload-dropzone order-2 relative flex flex-col items-center justify-center gap-4
                  w-full min-h-[320px]
                  rounded-none border-0 p-6 pt-16
                  transition-all duration-300 select-none
                  ${!jobDescription.trim()
                    ? "cursor-not-allowed"
                    : "cursor-pointer"
                  }
                  ${isDragOver && jobDescription.trim()
                    ? "border-line bg-tint"
                    : jdError
                      ? "border-danger/30 bg-danger-soft"
                      : jobDescription.trim()
                        ? "border-line bg-surface hover:border-line hover:bg-tint"
                        : "border-line bg-tint"
                  }
                `}
              >
                <span className="absolute top-6 left-6 font-mono text-xs font-bold uppercase tracking-wide text-ink">02 · Resume PDF</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={handleFileChange}
                  aria-label="Upload resume PDF"
                />

                <motion.div
                  animate={{ y: isDragOver ? -4 : 0 }}
                  transition={{ duration: 0.2 }}
                  className="w-14 h-14 rounded-none bg-accent text-on-accent border border-line flex items-center justify-center"
                >
                  <UploadCloud className="w-7 h-7 text-on-accent" />
                </motion.div>

                <div className="text-center space-y-2 px-6">
                  <p className="text-xl font-bold text-ink leading-snug">
                    Upload your resume
                  </p>
                  <p className="text-xs text-muted mt-1">
                    {jobDescription.trim()
                      ? "Job description ready. Drop your PDF to begin."
                      : "Add the job description first, then upload your PDF."
                    }
                  </p>
                  <p className="text-sm text-muted">
                    PDF only · Max {MAX_FILE_SIZE_MB}MB
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <div className="hidden" />
                  <span className="retro-button inline-flex items-center gap-4 bg-accent text-on-accent border border-line px-4 py-3 text-xs font-mono font-bold uppercase tracking-wide">
                    Browse PDF <ArrowUpRight size={18} aria-hidden="true" />
                  </span>
                  <div className="hidden" />
                </div>

                  <AnimatePresence>
                  {isDragOver && jobDescription.trim() && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="absolute inset-0 rounded-none bg-white/[0.02] pointer-events-none"
                    />
                  )}
                </AnimatePresence>
              </motion.div>

              {/* ── JD INPUT SECTION ── */}
              <div className="job-description-panel order-1 w-full border-b md:border-b-0 md:border-r border-line bg-surface p-6 flex flex-col gap-4">
                {/* Section Label */}
                <div className="flex items-center justify-between">
                  <label htmlFor="job-description" className="font-mono text-xs font-bold uppercase tracking-wide text-ink">
                    01 · Job description
                  </label>
                  <span className={`text-xs tabular-nums transition-colors duration-200 ${jobDescription.length > 50 ? "text-brand" : "text-muted"}`}>
                    {jobDescription.length} chars
                  </span>
                </div>

                {/* Textarea */}
                <div className="relative flex-1">
                  <textarea
                    id="job-description"
                    value={jobDescription}
                    onChange={(e) => {
                      setJobDescription(e.target.value);
                      if (jdError) setJdError(false);
                    }}
                    placeholder="Paste the role’s responsibilities, required skills, and experience here…"
                    rows={4}
                    className={`
                      w-full h-full min-h-[180px] bg-tint rounded-[4px] p-4
                      text-sm text-copy placeholder:text-muted
                      border transition-all duration-300
                      focus:outline-none resize-none
                      leading-relaxed
                      ${jdError
                        ? "border-danger/30 focus:border-danger bg-danger-soft"
                        : jobDescription.length > 50
                          ? "border-line focus:border-line"
                          : "border-line focus:border-brand"
                      }
                    `}
                  />
                  {jobDescription.length > 50 && (
                    <div className="absolute top-3 right-3 pointer-events-none">
                      <CheckCircle size={14} className="text-brand" />
                    </div>
                  )}
                </div>

                {/* Error message */}
                <div className={`
                  flex items-center gap-2 px-3 py-2 rounded-none
                  border border-danger/20 bg-danger-soft
                  transition-all duration-300 ease-in-out
                  ${jdError ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1 hidden"}
                `}>
                  <AlertTriangle size={12} className="text-danger flex-shrink-0" />
                  <p className="text-xs text-danger">
                    Add a job description before uploading your resume.
                  </p>
                </div>

                <p className="text-xs text-muted leading-relaxed px-1">
                  Include the full description for a more useful review.
                </p>
              </div>

              <AnimatePresence>
                {appState === "error" && errorMessage && (
                  <div className="fixed inset-0 z-50 bg-overlay  flex items-center justify-center p-4">
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className="bg-surface border border-danger/20 rounded-none p-8 max-w-md w-full shadow-none flex flex-col items-center gap-5 text-center"
                    >
                      <div className="w-12 h-12 rounded-none bg-danger-soft border border-danger/20 text-danger flex items-center justify-center">
                        <AlertTriangle size={24} />
                      </div>
                      <div className="space-y-2">
                        <h3 className="text-lg font-bold text-ink tracking-wide">Unable to review this document</h3>
                        <p className="text-sm text-danger leading-relaxed font-medium">
                          {errorMessage}
                        </p>
                      </div>
                      <button
                        onClick={handleReset}
                        className="mt-2 w-full py-3.5 bg-brand hover:bg-brand-hover text-on-brand font-bold rounded-none transition-all text-xs font-sans uppercase tracking-wide shadow-none cursor-pointer"
                      >
                        Choose another resume
                      </button>
                    </motion.div>
                  </div>
                )}
              </AnimatePresence>
            </motion.div>
          ) : (
            <motion.div
              key="skeleton"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
              className="w-full"
            >
              <SkeletonDashboard />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.4 }}
        className="w-full max-w-6xl mt-4 border-t border-line pt-4 pb-6 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-muted"
      >
        Resume review · Technical interview practice · Clearer next steps
      </motion.p>
    </main>
  );
}

export interface InterviewReport {
  overall_defense_score: number;
  mode_evaluated: string;
  defense_verdict: string;
  phase1_mistakes: Array<{
    question_label: string;
    score: number;
    is_unanswered: boolean;
    feedback: string;
    failsafe_recommendation: string;
  }>;
  phase2_corrections: Array<{ category: string; bullet: string }>;
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isMistake(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return isScore(item.score) && typeof item.is_unanswered === "boolean"
    && ["question_label", "feedback", "failsafe_recommendation"].every(key => typeof item[key] === "string");
}

function isCorrection(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.category === "string" && typeof item.bullet === "string";
}

export async function requestInterviewReport(resumeText: string, spokenTranscript: string, context: string): Promise<InterviewReport> {
  const response = await fetch("/api/rebuild", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resumeText, spokenTranscript, context }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(typeof data?.error === "string" ? data.error : "Interview feedback failed. Please retry.");
  }
  if (!data || !isScore(data.overall_defense_score)
    || typeof data.mode_evaluated !== "string" || typeof data.defense_verdict !== "string"
    || !Array.isArray(data.phase1_mistakes) || !data.phase1_mistakes.every(isMistake)
    || !Array.isArray(data.phase2_corrections) || !data.phase2_corrections.every(isCorrection)) {
    throw new Error("Interview feedback was incomplete. Please retry.");
  }
  return data as InterviewReport;
}

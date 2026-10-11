"use client";

import TypewriterText from "./TypewriterText";

const HEADLINES = [
  "Your resume is about to get destroyed.",
  "We expose every lie in your resume.",
  "Code doesn't lie. Your resume does.",
  "S.P.A.R.T.A. never shows mercy.",
  "Drop the PDF. Face the verdict.",
  "Your resume says 'ML Engineer'. Your GitHub says 'HTML + Vibes'.",
  "Cross-referencing your 'engineering' claims with actual reality.",
  "We search your repo for the code you actually wrote yourself.",
  "Scanning for the 'expert-level' skills you hallucinated.",
  "Translating your corporate buzzwords into actual technical debt.",
  "Converting fake metrics into real anxiety.",
] as const;

export default function TypewriterHeading() {
  return (
    <h1 className="typewriter-heading text-4xl sm:text-5xl lg:text-[4rem] font-bold text-ink">
      <TypewriterText lines={HEADLINES} />
    </h1>
  );
}

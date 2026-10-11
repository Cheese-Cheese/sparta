"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

function subscribeToMotionPreference(onChange: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function getMotionPreference() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getServerMotionPreference() {
  return true;
}

export default function TypewriterText({ lines }: { lines: readonly [string, ...string[]] }) {
  const reducedMotion = useSyncExternalStore(
    subscribeToMotionPreference,
    getMotionPreference,
    getServerMotionPreference,
  );
  const [frame, setFrame] = useState({ line: 0, length: 0, deleting: false });

  useEffect(() => {
    if (reducedMotion) return;

    const complete = frame.length === lines[frame.line].length;
    const erased = frame.deleting && frame.length === 0;
    const delay = !frame.deleting && complete ? 2000 : erased ? 300 : frame.deleting ? 28 : 55;
    const timer = window.setTimeout(() => {
      setFrame(previous => {
        if (!previous.deleting && complete) return { ...previous, deleting: true };
        if (erased) return { line: (previous.line + 1) % lines.length, length: 0, deleting: false };
        return { ...previous, length: previous.length + (previous.deleting ? -1 : 1) };
      });
    }, delay);

    return () => window.clearTimeout(timer);
  }, [frame, lines, reducedMotion]);

  const text = reducedMotion ? lines[0] : lines[frame.line].slice(0, frame.length);

  return (
    <span className="grid">
      <span className="sr-only">{lines[0]}</span>
      {/* Reserve the tallest line's space so typing cannot move nearby content. */}
      {lines.map(line => (
        <span key={line} aria-hidden="true" className="invisible [grid-area:1/1]">
          {line}<span className="typewriter-cursor" />
        </span>
      ))}
      <span aria-hidden="true" className="[grid-area:1/1]">
        {text}<span className="typewriter-cursor" />
      </span>
    </span>
  );
}

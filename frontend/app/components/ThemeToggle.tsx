"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

const STORAGE_KEY = "sparta-theme";
const CHANGE_EVENT = "sparta-theme-change";

function getSnapshot() {
  return document.documentElement.dataset.theme === "dark";
}

function getServerSnapshot() {
  return false;
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  const followSystem = () => {
    if (document.documentElement.dataset.themePreference !== "manual") {
      document.documentElement.dataset.theme = media.matches ? "dark" : "light";
      onChange();
    }
  };
  const syncStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    const saved = event.key === null ? null : event.newValue;
    const manual = saved === "dark" || saved === "light";
    document.documentElement.dataset.themePreference = manual ? "manual" : "system";
    document.documentElement.dataset.theme = manual ? saved : media.matches ? "dark" : "light";
    onChange();
  };

  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", syncStorage);
  media.addEventListener("change", followSystem);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", syncStorage);
    media.removeEventListener("change", followSystem);
  };
}

export default function ThemeToggle() {
  const isDark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";

  const toggleTheme = () => {
    const theme = getSnapshot() ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = "manual";
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // The switch still works when browser storage is unavailable.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-none border border-line bg-surface px-3 text-xs font-medium text-copy transition-colors hover:bg-tint hover:text-ink"
    >
      {isDark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
      <span className="hidden sm:inline">{isDark ? "Light mode" : "Dark mode"}</span>
    </button>
  );
}

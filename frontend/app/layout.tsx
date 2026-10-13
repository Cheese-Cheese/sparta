import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "S.P.A.R.T.A. — Smart Platform for Adversarial Readiness & Technical Assessment",
  description: "Smart Platform for Adversarial Readiness & Technical Assessment. FAANG-grade resume verification, code auditing, and live voice interrogation.",
  icons: {
    icon: { url: "/sparta-shield.svg", type: "image/svg+xml" },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: `
            (function () {
              var saved;
              try { saved = localStorage.getItem('sparta-theme'); } catch (_) {}
              var manual = saved === 'dark' || saved === 'light';
              document.documentElement.dataset.theme = manual ? saved :
                (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
              document.documentElement.dataset.themePreference = manual ? 'manual' : 'system';
            })();
          ` }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Fonts are vendored in app/fonts rather than pulled from next/font/google:
// the build no longer depends on reaching Google at build time, and no
// request leaves the visitor's browser to render the page.
const display = localFont({
  variable: "--font-display",
  display: "swap",
  src: [
    { path: "./fonts/barlow-condensed-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/barlow-condensed-700.woff2", weight: "700", style: "normal" },
  ],
});
const body = localFont({
  variable: "--font-body",
  display: "swap",
  src: [{ path: "./fonts/ibm-plex-sans-variable.woff2", weight: "400 600", style: "normal" }],
});

export const metadata: Metadata = {
  title: "Clear to Play — smoke-day practice calls for Boulder schools",
  description:
    "Reads AirNow monitor data for a school and a practice window, applies a published smoke policy, and returns a call with the evidence behind it.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable}`}>{children}</body>
    </html>
  );
}

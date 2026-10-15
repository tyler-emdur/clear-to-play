import type { Metadata } from "next";
import { Barlow_Condensed, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const display = Barlow_Condensed({
  subsets: ["latin"], weight: ["600", "700"], variable: "--font-display",
});
const body = IBM_Plex_Sans({
  subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-body",
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

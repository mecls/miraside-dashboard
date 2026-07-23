import "react-day-picker/style.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";

// Supabase uses its custom "Circular" face; Inter (variable) is the standard stand-in —
// it's what the reference Supabase-style ports ship with.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Miraside Dashboard",
  description: "Meta Ads + GoHighLevel performance dashboard",
};

/**
 * `viewportFit: "cover"` is what makes env(safe-area-inset-*) report real numbers on an iPhone —
 * without it those values are always 0 and the safe-area padding does nothing. Zoom is deliberately
 * left enabled: pinching to read a phone number is exactly what someone does on a small screen.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0a",
};

// Bare shell only. The dashboard chrome (sidebar/nav) lives in app/(app)/layout.tsx so
// the /login route renders without it.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}

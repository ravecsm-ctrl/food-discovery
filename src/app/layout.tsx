import type { Metadata, Viewport } from "next";
import { Fraunces } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", display: "swap" });

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "Food Discovery — Prototype",
  description: "Swipe through dishes and get one to three ideas for what to eat. Local intelligence prototype.",
  manifest: `${base}/manifest.webmanifest`,
  icons: {
    icon: [{ url: `${base}/icon.svg`, type: "image/svg+xml" }, { url: `${base}/icon-192.png`, sizes: "192x192" }],
    apple: [{ url: `${base}/icon-180.png`, sizes: "180x180" }],
  },
  appleWebApp: { capable: true, title: "Food Discovery", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbf6ef" },
    { media: "(prefers-color-scheme: dark)", color: "#17120f" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={fraunces.variable}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}

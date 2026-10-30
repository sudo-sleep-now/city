import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SOLHEIM 2050 — City D Pilot District",
  description:
    "A proposed pilot district for a car-dependent city: reliable buses, safer short trips and local services. Future Cities Summit 2050.",
  keywords: [
    "SOLHEIM",
    "Three.js",
    "Next.js",
    "TypeScript",
    "procedural generation",
    "walkable city",
    "urban planning",
    "3D city simulation",
  ],
  authors: [{ name: "SOLHEIM Project" }],
  openGraph: {
    title: "SOLHEIM 2050 — City D Pilot District",
    description:
      "Explore a proposed district retrofit for City D, with useful transport alternatives and fair access before restrictions.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0a1f14",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}

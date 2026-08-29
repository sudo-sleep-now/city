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
  title: "SOLHEIM — A Walkable 3D Optimal City",
  description:
    "A fully procedural, walkable first-person 3D city of ≈13,000 residents — built with Next.js, TypeScript and Three.js. A school project on optimal urban design.",
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
    title: "SOLHEIM — A Walkable 3D Optimal City",
    description:
      "Explore a compact, transit-first city designed around short distances, mixed neighborhoods and streets that put people before cars.",
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

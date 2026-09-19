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
  // Still the create-next-app default until now: every browser tab, every
  // bookmark and every screenshot a teacher sent to the helpdesk said
  // "Create Next App".
  title: {
    default: "Goldenmile RTT LMS",
    template: "%s · Goldenmile RTT LMS",
  },
  description:
    "Refresher Teacher Training programme platform for Goldenmile Learning, Ladakh-UT.",
  // Internal tool holding classroom recordings of identifiable children and
  // their guardians' details. It should not be indexed anywhere, ever.
  robots: { index: false, follow: false, nocache: true },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

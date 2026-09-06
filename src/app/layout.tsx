import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TeachCast — Computer-Use Teaching Studio",
  description:
    "Share your screen, teach a real LLM your workflows through live interactive sessions, then install them as launchable apps and replay them against your screen.",
  keywords: ["TeachCast", "computer use", "screen share", "LLM", "workflow automation", "teaching studio"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#09090b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        {/* Toasts sit top-LEFT below the header: never over the composer/Send
            button (bottom-right) and never over the stage's Stop control
            (top-right). Transient + click-dismissible, so they cannot block
            navigation either. */}
        <Toaster position="top-left" offset={64} richColors closeButton />
      </body>
    </html>
  );
}

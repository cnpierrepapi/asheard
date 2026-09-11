import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Chrome } from "@/components/chrome";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const DESCRIPTION =
  "CALL-E says the job's done. As Heard checks who actually picked up, and points at the field it read.";

export const metadata: Metadata = {
  metadataBase: new URL("https://asheard.vercel.app"),
  applicationName: "As Heard",
  title: { default: "As Heard", template: "%s · As Heard" },
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "As Heard",
    title: "As Heard",
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "As Heard",
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Chrome />
        {children}
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Demo Discord — Real-Time Voice & Chat",
  description: "High-throughput distributed chat and Mediasoup SFU WebRTC voice stage",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans bg-[#08090C] text-[#F2F3F5] antialiased min-h-screen overflow-hidden">
        {children}
      </body>
    </html>
  );
}
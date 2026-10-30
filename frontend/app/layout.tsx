import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Demo Discord — Real-Time Voice & Chat",
  description: "High-throughput distributed chat and Mediasoup SFU WebRTC voice stage",
};

// viewport-fit=cover lets the phone layout draw edge to edge; AppShell pads for the notch.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0b0a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans bg-canvas text-ink antialiased min-h-screen overflow-hidden">
        {children}
      </body>
    </html>
  );
}
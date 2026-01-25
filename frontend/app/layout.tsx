import type { Metadata } from "next";
import "./globals.css"; // This line is essential to load your Tailwind styles

export const metadata: Metadata = {
  title: "Chat App",
  description: "A real-time chat application",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      {/* 
        The 'font-sans' class applies the default sans-serif font family defined in your Tailwind config.
        'bg-gray-900' and 'text-gray-100' set a default dark theme for the whole app,
        preventing a white flash on initial load.
      */}
      <body className="font-sans bg-gray-900 text-gray-100">
        {children}
      </body>
    </html>
  );
}
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Asia Poker Calendar",
  description: "Asia poker tournament schedule",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}

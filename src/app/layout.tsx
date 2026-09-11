import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "台灣撲克玩家行事曆 Taiwan Poker Player Calendar",
  description: "台灣撲克玩家的賽事行事曆：台灣本地與亞洲主要撲克錦標賽系列的日期、地點、主賽買入",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}

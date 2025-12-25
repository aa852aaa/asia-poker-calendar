import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "亞洲撲克賽程表 Asia Poker Calendar",
  description: "Asia poker tournament schedule",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>
        {children}

        <style jsx global>{`
          :root {
            --bg: #ffffff;
            --text: #111111;
            --muted: rgba(17, 17, 17, 0.7);
            --card: #ffffff;
            --border: #e5e5e5;
            --chip-bg: transparent;
            --chip-active-bg: #111111;
            --chip-active-text: #ffffff;
            --input-bg: #ffffff;
            --link: #0b57d0;
            --header-bg: #ffffff;
          }

          @media (prefers-color-scheme: dark) {
            :root {
              --bg: #0b0b0b;
              --text: #f3f3f3;
              --muted: rgba(243, 243, 243, 0.75);
              --card: #121212;
              --border: rgba(255, 255, 255, 0.14);
              --chip-bg: transparent;
              --chip-active-bg: #f3f3f3;
              --chip-active-text: #0b0b0b;
              --input-bg: #121212;
              --link: #6ea8ff;
              --header-bg: #0b0b0b;
            }
          }

          body {
            background: var(--bg);
            color: var(--text);
          }
        `}</style>
      </body>
    </html>
  );
}

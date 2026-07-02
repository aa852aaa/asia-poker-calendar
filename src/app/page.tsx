import ScheduleTable from "./components/ScheduleTable";
import { getScheduleRows } from "./lib/schedule";
import { Row } from "./lib/types";

// ISR：頁面預先渲染成靜態，每 60 秒在背景更新一次
export const revalidate = 60;

export default async function Page() {
  const font = { fontFamily: "system-ui, sans-serif" as const };

  let rows: Row[] | null = null;
  let errorMessage: string | null = null;

  try {
    rows = await getScheduleRows();
  } catch (e) {
    console.error("Failed to load schedule:", e);
    errorMessage = e instanceof Error ? e.message : "Unknown error";
  }

  if (rows === null) {
    return (
      <main style={{ padding: 24, ...font }}>
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>Asia Poker Calendar</h1>
        <p style={{ marginTop: 12 }}>❌ 賽程載入失敗：{errorMessage}</p>
        <p style={{ marginTop: 8 }}>
          （通常是 Vercel 沒設定 <code>SHEET_CSV_URL</code>，或 Google Sheets 暫時無法連線，稍後重新整理再試）
        </p>
      </main>
    );
  }

  return (
    <main style={{ padding: 24, ...font }}>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>Asia Poker Calendar</h1>
      <ScheduleTable rows={rows} />
    </main>
  );
}

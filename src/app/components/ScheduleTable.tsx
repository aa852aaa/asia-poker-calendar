"use client";

import { useMemo, useState } from "react";

type Row = {
  "Start Date": string;
  "End Date": string;
  "Location": string;
  "Tournament": string;
  "ME Buy-in": string;
  "Currency": string;
  "Handbook URL": string;
  usd?: number | null;
};

function toNumber(x: string | undefined): number | null {
  const s = String(x ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function norm(s: string): string {
  return String(s ?? "").trim().toLowerCase();
}

// ✅ 固定只提供兩個快選（不影響下拉與顯示）
const QUICK_LOCATION_KEYWORDS = ["Taiwan", "Korea"] as const;

export default function ScheduleTable({ rows }: { rows: Row[] }) {
  const [locationPick, setLocationPick] = useState<string>("ALL");
  const [tournamentQuery, setTournamentQuery] = useState<string>("");

  // 產生 Location 清單（去重 + 排序）— 下拉維持原樣
  const locations = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const loc = String(r["Location"] ?? "").trim();
      if (loc) set.add(loc);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = norm(tournamentQuery);
    const locAll = locationPick === "ALL";

    return rows.filter((r) => {
      const locRaw = String(r["Location"] ?? "").trim();

      // ✅ 篩選器維持原樣：
      // - ALL：不篩
      // - 下拉選到某個完整 Location：用全等
      // - chips（Taiwan/Korea）：用包含比對（支援 "Taipei, Taiwan" 這類）
      let locOk = true;
      if (!locAll) {
        const isQuick = (QUICK_LOCATION_KEYWORDS as readonly string[]).includes(locationPick);
        locOk = isQuick ? norm(locRaw).includes(norm(locationPick)) : locRaw === locationPick;
      }

      if (!locOk) return false;
      if (!q) return true;

      // Tournament 只做搜尋：比對 Tournament（也順手比對 Location，避免使用者打城市名卻搜不到）
      const t = norm(r["Tournament"]);
      const l = norm(r["Location"]);
      return t.includes(q) || l.includes(q);
    });
  }, [rows, locationPick, tournamentQuery]);

  return (
    <div style={{ marginTop: 16 }}>
      {/* 控制列 */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        {/* Location 下拉（維持原樣） */}
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontWeight: 600 }}>Location</span>
          <select
            value={locationPick}
            onChange={(e) => setLocationPick(e.target.value)}
            style={{
              padding: "6px 10px",
              border: "1px solid #ddd",
              borderRadius: 8,
            }}
          >
            <option value="ALL">All</option>
            {locations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
        </label>

        {/* Tournament 搜尋（維持原樣） */}
        <label style={{ display: "flex", gap: 8, alignItems: "center", flex: "1 1 260px" }}>
          <span style={{ fontWeight: 600 }}>Tournament</span>
          <input
            value={tournamentQuery}
            onChange={(e) => setTournamentQuery(e.target.value)}
            placeholder="Search tournament..."
            style={{
              width: "100%",
              padding: "6px 10px",
              border: "1px solid #ddd",
              borderRadius: 8,
            }}
          />
        </label>

        {/* 結果數 */}
        <div style={{ marginLeft: "auto", opacity: 0.8 }}>
          Showing <b>{filtered.length}</b> / {rows.length}
        </div>
      </div>

      {/* Location 快選（chips）：只保留 Taiwan / Korea */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <button
          onClick={() => setLocationPick("ALL")}
          style={{
            padding: "6px 10px",
            borderRadius: 999,
            border: "1px solid #ddd",
            background: locationPick === "ALL" ? "#111" : "transparent",
            color: locationPick === "ALL" ? "#fff" : "inherit",
            cursor: "pointer",
          }}
        >
          All
        </button>

        {QUICK_LOCATION_KEYWORDS.map((loc) => (
          <button
            key={loc}
            onClick={() => setLocationPick(loc)}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid #ddd",
              background: locationPick === loc ? "#111" : "transparent",
              color: locationPick === loc ? "#fff" : "inherit",
              cursor: "pointer",
            }}
            title={loc}
          >
            {loc}
          </button>
        ))}
      </div>

      {/* 表格 */}
      <div style={{ overflowX: "auto" }}>
        <table cellPadding={10} style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th align="left">Start</th>
              <th align="left">End</th>
              <th align="left">Location</th>
              <th align="left">Tournament</th>
              <th align="right">Buy-in (Local)</th>
              <th align="right">Buy-in (USD)</th>
            </tr>
          </thead>

          <tbody>
            {filtered.map((r, i) => {
              const rawBuyin = String(r["ME Buy-in"] ?? "").trim();
              const amount = toNumber(r["ME Buy-in"]);
              const ccy = String(r["Currency"] || "").toUpperCase();
              const usd = r.usd;

              return (
                <tr key={`${r["Start Date"]}-${r["Tournament"]}-${i}`} style={{ borderTop: "1px solid #ddd" }}>
                  <td>{r["Start Date"]}</td>
                  <td>{r["End Date"]}</td>
                  <td>{r["Location"]}</td>
                  <td>
                    {r["Handbook URL"] ? (
                      <a href={r["Handbook URL"]} target="_blank" rel="noreferrer">
                        {r["Tournament"]}
                      </a>
                    ) : (
                      r["Tournament"]
                    )}
                  </td>

                  {/* Buy-in 空白顯示 '-' */}
                  <td align="right">
                    {(() => {
                      if (!rawBuyin) return "-";
                      if (amount != null) return `${ccy} ${amount.toLocaleString()}`;
                      return rawBuyin; // 例如 TBA/TBD
                    })()}
                  </td>

                  <td align="right">{usd != null ? `$${Number(usd).toFixed(0)}` : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

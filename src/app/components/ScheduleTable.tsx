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

// 支援 YYYY-MM-DD / YYYY/MM/DD / YYYY-M-D / YYYY/M/D
function parseDateFlexible(dateStr: string): Date | null {
  const s = String(dateStr ?? "").trim().replace(/\u3000/g, " ").trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  return new Date(y, mo - 1, d, 0, 0, 0, 0);
}

function daysUntilEnd(endStr: string): number | null {
  const end = parseDateFlexible(endStr);
  if (!end) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const diffMs = end.getTime() - today.getTime();
  return Math.floor(diffMs / (24 * 60 * 60 * 1000)); // 0=今天結束, 1=明天結束
}

// 固定只提供兩個快選 chips（下拉維持原樣）
const QUICK_LOCATION_KEYWORDS = ["Taiwan", "Korea"] as const;

export default function ScheduleTable({ rows }: { rows: Row[] }) {
  const [locationPick, setLocationPick] = useState<string>("ALL");
  const [tournamentQuery, setTournamentQuery] = useState<string>("");

  // 下拉：完整 Location 清單
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

      // Location 篩選：下拉用全等，chips 用包含
      let locOk = true;
      if (!locAll) {
        const isQuick = (QUICK_LOCATION_KEYWORDS as readonly string[]).includes(locationPick);
        locOk = isQuick ? norm(locRaw).includes(norm(locationPick)) : locRaw === locationPick;
      }
      if (!locOk) return false;

      if (!q) return true;

      const t = norm(r["Tournament"]);
      const l = norm(r["Location"]);
      return t.includes(q) || l.includes(q);
    });
  }, [rows, locationPick, tournamentQuery]);

  const igUrl = "https://www.instagram.com/asmallbean/"; // 你要換 IG 就改這裡

  return (
    <div style={{ marginTop: 16 }}>
      {/* 控制列 */}
      <div className="controls">
        <label className="controlItem">
          <span className="label">Location</span>
          <select value={locationPick} onChange={(e) => setLocationPick(e.target.value)} className="select">
            <option value="ALL">All</option>
            {locations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
        </label>

        <label className="controlItem controlGrow">
          <span className="label">Tournament</span>
          <input
            value={tournamentQuery}
            onChange={(e) => setTournamentQuery(e.target.value)}
            placeholder="Search tournament..."
            className="input"
          />
        </label>

        <div className="resultCount">
          Showing <b>{filtered.length}</b> / {rows.length}
        </div>
      </div>

      {/* 快選 chips */}
      <div className="chips">
        <button onClick={() => setLocationPick("ALL")} className={`chip ${locationPick === "ALL" ? "chipActive" : ""}`}>
          All
        </button>

        {QUICK_LOCATION_KEYWORDS.map((loc) => (
          <button
            key={loc}
            onClick={() => setLocationPick(loc)}
            className={`chip ${locationPick === loc ? "chipActive" : ""}`}
            title={loc}
          >
            {loc}
          </button>
        ))}
      </div>

      {/* 桌機：表格 */}
      <div className="tableWrap">
        <table className="table">
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

              const dLeft = daysUntilEnd(r["End Date"]);
              // ✅ 結束前 3 天到結束後 3 天（你說你改成結束後 3 天就消失）
              const endingSoon = dLeft != null && dLeft <= 3 && dLeft >= -3;

              return (
                <tr key={`${r["Start Date"]}-${r["Tournament"]}-${i}`} className={`row ${endingSoon ? "rowSoon" : ""}`}>
                  <td className="cell nowrap">{r["Start Date"]}</td>
                  <td className="cell nowrap">{r["End Date"]}</td>
                  <td className="cell nowrap">{r["Location"]}</td>

                  <td className="cell tournamentCell">
                    {r["Handbook URL"] ? (
                      <a className="tLink" href={r["Handbook URL"]} target="_blank" rel="noreferrer">
                        {r["Tournament"]}
                      </a>
                    ) : (
                      r["Tournament"]
                    )}
                  </td>

                  <td className="cell nowrap" style={{ textAlign: "right" }}>
                    {(() => {
                      if (!rawBuyin) return "-";
                      if (amount != null) return `${ccy} ${amount.toLocaleString()}`;
                      return rawBuyin;
                    })()}
                  </td>

                  <td className="cell nowrap" style={{ textAlign: "right" }}>
                    {usd != null ? `$${Number(usd).toFixed(0)}` : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 手機：卡片 */}
      <div className="cards">
        {filtered.map((r, i) => {
          const rawBuyin = String(r["ME Buy-in"] ?? "").trim();
          const amount = toNumber(r["ME Buy-in"]);
          const ccy = String(r["Currency"] || "").toUpperCase();
          const usd = r.usd;

          const dLeft = daysUntilEnd(r["End Date"]);
          const endingSoon = dLeft != null && dLeft <= 3 && dLeft >= -3;

          const buyLocal = (() => {
            if (!rawBuyin) return "-";
            if (amount != null) return `${ccy} ${amount.toLocaleString()}`;
            return rawBuyin;
          })();

          return (
            <div key={`${r["Start Date"]}-${r["Tournament"]}-${i}`} className={`card ${endingSoon ? "cardSoon" : ""}`}>
              <div className="cardTop">
                <div className="cardTitle">
                  {r["Handbook URL"] ? (
                    <a className="tLink" href={r["Handbook URL"]} target="_blank" rel="noreferrer">
                      {r["Tournament"]}
                    </a>
                  ) : (
                    r["Tournament"]
                  )}
                </div>

                <div className="cardMeta">
                  <span className="pill">
                    {r["Start Date"]} → {r["End Date"]}
                  </span>
                  <span className="pill" title={r["Location"]}>
                    {r["Location"]}
                  </span>
                </div>
              </div>

              <div className="cardBottom">
                <div className="kv">
                  <div className="k">Buy-in (Local)</div>
                  <div className="v">{buyLocal}</div>
                </div>
                <div className="kv">
                  <div className="k">Buy-in (USD)</div>
                  <div className="v">{usd != null ? `$${Number(usd).toFixed(0)}` : "-"}</div>
                </div>
              </div>

              {endingSoon && (
                <div className="soonHint">
                  ⏳ Ending soon
                  {dLeft === 0 ? " (today)" : dLeft != null ? ` (${Math.abs(dLeft)} day${Math.abs(dLeft) === 1 ? "" : "s"} ${dLeft > 0 ? "left" : "after"})` : ""}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 浮水印 */}
      <div className="footer">
        <span>Made by 豆砸 AsmallBean</span>
        <span className="dot">·</span>
        <a className="ig" href={igUrl} target="_blank" rel="noreferrer">
          IG
        </a>
      </div>
\
    </div>
  );
}

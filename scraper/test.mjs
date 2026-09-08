// 純邏輯測試（不需要任何金鑰、不連網）
//   node test.mjs

import { readFile } from "node:fs/promises";
import {
  passesGeoRule, isAsia, isNonAsiaAllowed, cleanLink, parseTribeEvents,
  mergeGroup, detectDateChange, validateEvent, colLetter, htmlToText,
  fixCountry, fixCity, isDuplicateConservative,
} from "./index.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? "  → " + extra : ""}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，預期 ${JSON.stringify(want)}`);

const blacklist = /(pokercalendar\.asia|somuchpoker\.com|pokernews\.com|thehendonmob\.com|cardplayer\.com|pokerfuse\.com|globalpokerindex\.com|jopt\.jp)/i;
const geo = (t, l) => passesGeoRule({ Tournament: t, Location: l });

console.log("\n【1】地區規則：西太平洋（東亞）+ 東南亞，另加 WSOP / WSOP Paradise 兩個例外");
ok("台北收", geo("APT Championship Taipei 2026", "Taipei, Taiwan"));
ok("濟州收", geo("GOP Jeju 2026", "Jeju, South Korea"));
ok("馬尼拉收", geo("APPT Manila", "Manila, Philippines"));
ok("河內收（Viet Nam 正規化後）", geo("RPT Championship", `Hanoi, ${fixCountry("Viet Nam")}`));
ok("澳門收", geo("MGM Poker Championship", "Cotai, Macau"));
ok("WSOP Paradise 巴哈馬 → 收", geo("WSOP Paradise", "Paradise, Bahamas"));
ok("夏季 WSOP 拉斯維加斯 → 收", geo("World Series of Poker 2027", "Las Vegas, United States"));
ok("OLA Rozvadov 捷克 → 不收", !geo("Ola Poker Tour 2026 Rozvadov", "Rozvadov, Czech Republic"));
ok("EPT Barcelona → 不收", !geo("EPT Barcelona 2026", "Barcelona, Spain"));
ok("WPT 不在非亞洲白名單", !isNonAsiaAllowed("WPT Cyprus 2026"));
ok("WPT Cyprus 賽普勒斯 → 不收（西亞但實為歐洲巡迴賽場地）", !geo("WPT Cyprus 2026", "Kyrenia, Cyprus"));
ok("WPT Seoul 韓國 → 收（亞洲站，巡迴賽名稱不影響）", geo("WPT Seoul 2026", "Incheon, South Korea"));
ok("WSOP Circuit 歐洲站 → 不收", !geo("WSOP Circuit Rozvadov", "Rozvadov, Czech Republic"));
ok("Triton 蒙特內哥羅 → 不收", !geo("Triton Super High Roller Series Montenegro", "Budva, Montenegro"));
ok("Triton 濟州 → 收（亞洲站）", geo("Triton ONE Jeju", "Jeju, South Korea"));
ok("WPT Cambodia 金邊 → 收", geo("WPT Cambodia 2027", "Phnom Penh, Cambodia"));
ok("東南亞：泰國、印尼、汶萊都收",
  geo("X", "Bangkok, Thailand") && geo("X", "Jakarta, Indonesia") && geo("X", "Brunei"));
ok("南亞：印度不收（超出西太平洋+東南亞）", !geo("India Poker Championship", "Goa, India"));
ok("南亞：斯里蘭卡不收", !geo("Poker Dream Sri Lanka", "Colombo, Sri Lanka"));
ok("中亞：烏茲別克不收", !geo("Merit Poker Tashkent", "Tashkent, Uzbekistan"));
ok("西亞：土耳其不收", !geo("Some Series", "Istanbul, Turkey"));
ok("澳洲不收", !geo("APL Million", "Southport, Australia"));
ok("只有國家沒城市也能判", isAsia("Malaysia"));
ok("空地點 → 不收", !geo("Some Event", ""));

console.log("\n【2】連結黑名單：絕不指向彙整站");
eq("PCA 連結被丟棄", cleanLink("https://pokercalendar.asia/en/pokertournaments/x/", blacklist), "");
eq("SoMuchPoker 連結被丟棄", cleanLink("https://somuchpoker.com/events-calendar/apc/2026/x", blacklist), "");
eq("Hendon Mob 連結被丟棄", cleanLink("https://pokerdb.thehendonmob.com/festival.php", blacklist), "");
eq("jopt.jp（已易主）被丟棄", cleanLink("https://jopt.jp/", blacklist), "");
eq("主辦官網保留", cleanLink("https://godsofpoker.com/series/taipei-2026-ii", blacklist),
  "https://godsofpoker.com/series/taipei-2026-ii");
eq("非 http 開頭丟棄", cleanLink("/series/x", blacklist), "");

console.log("\n【3】PCA JSON 解析（用真實 API 回應）");
const pcaRaw = JSON.parse(await readFile("../.scraper-test/T3_PokerCalendar_asia_API.txt", "utf8"));
const parsed = parseTribeEvents(pcaRaw, blacklist);
ok(`解析出 ${parsed.length} 筆`, parsed.length > 20);
ok("沒有任何一筆的連結指向彙整站", parsed.every((e) => !blacklist.test(e.detail_url || "x_none")));
ok("日期是 YYYY-MM-DD", parsed.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.start_date)));
ok("Korea, Republic of 已正規化成 South Korea",
  !parsed.some((e) => /Korea, Republic of/.test(e.location)) &&
  parsed.some((e) => /South Korea/.test(e.location)));
ok("Viet Nam 已正規化成 Vietnam",
  !parsed.some((e) => /Viet Nam/.test(e.location)) && parsed.some((e) => /Vietnam/.test(e.location)));
ok("HTML 編碼已還原（沒有殘留 &#8211;）", !parsed.some((e) => /&#\d+;/.test(e.tournament)));

console.log("\n【4】三層優先序合併：每個欄位取 tier 最小且有值的來源");
const cands = [
  { "Start Date": "2026-11-12", "End Date": "2026-11-29", Location: "Taipei, Taiwan",
    Tournament: "APT Championship, Taipei 2026", "Handbook URL": "", _tier: 1, _src: "APT" },
  { "Start Date": "2026-11-13", "End Date": "2026-11-29", Location: "Taipei, Taiwan",
    Tournament: "APT Championship Taipei 2026", "Handbook URL": "https://ctpclub.app/x", _tier: 2, _src: "CTP" },
  { "Start Date": "2026-11-13", "End Date": "2026-11-29", Location: "Taipei City, Taiwan",
    Tournament: "APT Championship Taipei 2026", "Handbook URL": "https://example.org/y", _tier: 3, _src: "PCA" },
];
const m = mergeGroup({ idxs: [2, 0, 1] }, cands); // 故意亂序，確認有依 tier 排序
eq("日期取 T1 主辦方的 11-12", m["Start Date"], "2026-11-12");
eq("名稱取 T1 的", m.Tournament, "APT Championship, Taipei 2026");
eq("T1 沒有連結 → 退回 T2 場館的", m["Handbook URL"], "https://ctpclub.app/x");
eq("最佳 tier 記錄為 1", m._bestTier, 1);

console.log("\n【5】改期偵測（你表上的日期是早期公布值，之後主辦方改期）");
const sheetRow = { _row: 4, Tournament: "APT JEJU 2026", "Start Date": "2026-09-25", "End Date": "2026-10-04" };
const fromT1 = { "Start Date": "2026-09-25", "End Date": "2026-10-07", _bestTier: 1, _srcs: ["T1:APT"] };
const chg = detectDateChange(fromT1, sheetRow);
ok("T1 來源日期不同 → 回報改期", chg !== null);
eq("回報的新結束日", chg?.newEnd, "2026-10-07");
eq("回報的舊結束日", chg?.oldEnd, "2026-10-04");
eq("回報試算表列號", chg?.row, 4);
ok("T3 彙整站的日期不拿來改人工資料",
  detectDateChange({ ...fromT1, _bestTier: 3 }, sheetRow) === null);
ok("日期完全相同 → 不回報",
  detectDateChange({ "Start Date": "2026-09-25", "End Date": "2026-10-04", _bestTier: 1, _srcs: ["T1:APT"] }, sheetRow) === null);
ok("差超過 45 天 → 不當成改期（可能根本不是同一場）",
  detectDateChange({ "Start Date": "2027-03-01", "End Date": "2027-03-10", _bestTier: 1, _srcs: ["T1:APT"] }, sheetRow) === null);
ok("對不到列 → 不回報", detectDateChange(fromT1, null) === null);

console.log("\n【6】寫入驗證");
const todayTs = Date.parse("2026-09-09T00:00:00+08:00");
const mk = (o) => ({ "Start Date": "2026-10-01", "End Date": "2026-10-05", Location: "Taipei, Taiwan", Tournament: "Some Poker Series", ...o });
eq("正常的過", validateEvent(mk({}), todayTs), null);
ok("已取消的擋掉", validateEvent(mk({ Tournament: "***CANCELLED*** Poker Dream 27" }), todayTs) === "已取消");
ok("結束早於開始擋掉", validateEvent(mk({ "Start Date": "2026-10-05", "End Date": "2026-10-01" }), todayTs) === "結束早於開始");
ok("賽期超過 60 天擋掉", validateEvent(mk({ "End Date": "2027-01-30" }), todayTs) === "賽期超過 60 天（可疑）");
ok("已結束的擋掉", validateEvent(mk({ "Start Date": "2026-08-01", "End Date": "2026-08-10" }), todayTs) === "已結束");
ok("沒有地點擋掉", validateEvent(mk({ Location: "" }), todayTs) === "沒有地點");
ok("捷克賽事擋掉", String(validateEvent(mk({ Location: "Rozvadov, Czech Republic" }), todayTs)).startsWith("地區不收"));
ok("日期格式不對擋掉", validateEvent(mk({ "Start Date": "Oct 1 2026" }), todayTs) === "日期格式不對");

console.log("\n【7】試算表欄位字母");
eq("第 0 欄 = A", colLetter(0), "A");
eq("第 6 欄 = G", colLetter(6), "G");
eq("第 25 欄 = Z", colLetter(25), "Z");
eq("第 26 欄 = AA", colLetter(26), "AA");

console.log("\n【8】HTML 轉文字：保留 img alt（Red Dragon 的賽事名只存在 alt 裡）");
const html = `<div><!-- <img alt="註解掉的舊賽事"> --><a href="/RDPT/jeju-2026.html"><img class="x" src="a.png" alt="Jeju Poker Festival 2026"/></a></div>`;
const txt = htmlToText(html, "https://playreddragon.com/series-schedule.html");
ok("賽事名從 alt 取出來了", txt.includes("[img:Jeju Poker Festival 2026]"), txt);
ok("相對連結轉成絕對網址", txt.includes("[link:https://playreddragon.com/RDPT/jeju-2026.html]"), txt);
ok("HTML 註解裡的舊內容被移除", !txt.includes("註解掉的舊賽事"), txt);

console.log("\n【9】保守去重（LLM 失敗時的退路：寧可漏不要錯）");
const sheet = [{ Tournament: "HPC", "Start Date": "2026-09-30", "End Date": "2026-10-04" }];
// 已知限制：字串比對認不出 "HPC" = "Harbour Poker Cup"，所以正式流程用 LLM 分組，
// 這個保守版只在 LLM 失敗時當退路。這條測試把限制釘住，之後若改演算法會被提醒。
ok("已知限制：HPC vs Harbour Poker Cup 字串比對認不出來（所以才需要 LLM 分組）",
  isDuplicateConservative({ Tournament: "Harbour Poker Cup", "Start Date": "2026-09-30", "End Date": "2026-10-04" }, sheet) === false);
ok("日期完全不重疊 → 不是重複",
  !isDuplicateConservative({ Tournament: "HPC", "Start Date": "2026-12-01", "End Date": "2026-12-05" }, sheet));
ok("同名同日期 → 是重複",
  isDuplicateConservative({ Tournament: "HPC", "Start Date": "2026-09-30", "End Date": "2026-10-04" }, sheet));

console.log(`\n${"─".repeat(50)}\n通過 ${pass}｜失敗 ${fail}`);
process.exit(fail ? 1 : 0);

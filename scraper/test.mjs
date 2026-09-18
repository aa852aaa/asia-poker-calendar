// 純邏輯測試（不需要任何金鑰、不連網）
//   node test.mjs

import { readFile } from "node:fs/promises";
import {
  passesGeoRule, isAsia, isNonAsiaAllowed, cleanLink, parseTribeEvents,
  mergeGroup, detectDateChange, validateEvent, colLetter, htmlToText,
  fixCountry, fixCity, isDuplicateConservative, pickReplacementModel,
  applyBrand, festivalDays, isDailyQuotaError, packBatches, stripCancelMark, findSheetRow,
  formatLocation, pickBuyIn, seriesLink, detectBlankFills, detailTargets, isTransientSheetsError,
  detectLinkFixes, needsBrowser, buildTodoList, normalizeLink, isGenericLink, sameDomain, hostOf,
  findPdfLinks, isPdfUrl,
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
ok("澳洲收（2026-09-16 Wei 加入）", geo("APL Million", "Southport, Australia"));
ok("紐西蘭不收（Wei 只說澳洲）", !geo("NZ Poker Champs", "Auckland, New Zealand"));
ok("新喀里多尼亞不收（澳洲彙整站會列，但不在範圍）", !geo("Nouméa Poker Series", "Nouméa, New Caledonia"));
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

console.log("\n【3】PCA JSON 解析（樣本取自真實 API 回應，涵蓋各種髒資料情境）");
// 路徑以測試檔自己的位置為準，不受 cwd 影響；樣本檔進 repo，不依賴 .scraper-test/ 那種本機產物
const pcaRaw = JSON.parse(await readFile(new URL("./fixtures/pca-sample.json", import.meta.url), "utf8"));
const parsed = parseTribeEvents(pcaRaw, blacklist);
const byTitle = (kw) => parsed.find((e) => e.tournament.includes(kw));
eq("解析出 6 筆", parsed.length, 6);
ok("沒有任何一筆的連結指向彙整站", parsed.every((e) => !blacklist.test(e.detail_url || "x_none")));
eq("主辦與場館都是彙整站 → 連結清成空字串", byTitle("Blacklist Probe")?.detail_url, "");
ok("日期轉成 YYYY-MM-DD", parsed.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.start_date)));
eq('Korea, Republic of → South Korea，且 "Jeju,Korea" 城市正規化',
  byTitle("APT Jeju")?.location, "Jeju, South Korea");
eq("Viet Nam → Vietnam，且 Hà Nội → Hanoi", byTitle("RPT Championship")?.location, "Hanoi, Vietnam");
ok("HTML 編碼已還原（沒有殘留 &#8211;）", !parsed.some((e) => /&#\d+;/.test(e.tournament)));
eq("標題的 &#8211; 變成連字號", byTitle("Trial of Wisdom")?.tournament,
  "The Trial of Wisdom - GOP Taipei 2026 II");
eq("有主辦官網 → 用主辦的", byTitle("APT Jeju")?.detail_url, "http://www.theasianpokertour.com/");
eq("沒有主辦官網 → 退回場館官網", byTitle("Manila Super Series")?.detail_url, "http://www.okadamanila.com/");
eq("主辦和場館都沒有 → 留空", byTitle("Poker Dream 26")?.detail_url, "");
eq("只有國家沒城市時 location 只填國家", byTitle("Poker Dream 26")?.location, "Malaysia");
eq("城市正規化：Hạ Long → Ha Long", fixCity("Hạ Long"), "Ha Long");
eq("沒對照表的城市原樣保留", fixCity("Sapporo"), "Sapporo");

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
// 連結是誰給的也要記：升級既有列的泛用連結時只信 tier 1/2 的專屬頁
const candsHost = cands.map((c) => ({ ...c, _srcHost: ({ 1: "theasianpokertour.com", 2: "ctpclub.app", 3: "pokercalendar.asia" })[c._tier] }));
const mh = mergeGroup({ idxs: [0, 1, 2] }, candsHost);
eq("連結來自 T2 → _linkTier 是 2", mh._linkTier, 2);
eq("連結來源的網站是 CTP", mh._linkHost, "ctpclub.app");
eq("T1 自己就有連結 → _linkTier 是 1", mergeGroup({ idxs: [0, 1] }, candsHost.map((c, i) => (i === 0 ? { ...c, "Handbook URL": "https://www.theasianpokertour.com/series/x" } : c)))._linkTier, 1);
eq("沒有任何來源有連結 → Infinity（永遠不會拿來升級）", mergeGroup({ idxs: [0] }, candsHost)._linkTier, Infinity);

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
// 取消的賽事要通過驗證才能留下來比對表上既有列（比對到就加註記，不刪除那一列）
eq("標記為取消的照樣通過驗證", validateEvent(mk({ _cancelled: true }), todayTs), null);
eq("取消的不要求地點（彙整站常常不填）",
  validateEvent(mk({ _cancelled: true, Location: "" }), todayTs), null);
eq("取消的不套地區規則", validateEvent(mk({ _cancelled: true, Location: "Rozvadov, Czech Republic" }), todayTs), null);
ok("但取消的日期壞掉還是要擋",
  validateEvent(mk({ _cancelled: true, "Start Date": "Oct 1" }), todayTs) === "日期格式不對");
ok("結束早於開始擋掉", validateEvent(mk({ "Start Date": "2026-10-05", "End Date": "2026-10-01" }), todayTs) === "結束早於開始");
ok("賽期超過 60 天擋掉", validateEvent(mk({ "End Date": "2027-01-30" }), todayTs) === "賽期超過 60 天（可疑）");
ok("已結束的擋掉", validateEvent(mk({ "Start Date": "2026-08-01", "End Date": "2026-08-10" }), todayTs) === "已結束");
ok("沒有地點擋掉", validateEvent(mk({ Location: "" }), todayTs) === "沒有地點");
ok("捷克賽事擋掉", String(validateEvent(mk({ Location: "Rozvadov, Czech Republic" }), todayTs)).startsWith("地區不收"));
ok("日期格式不對擋掉", validateEvent(mk({ "Start Date": "Oct 1 2026" }), todayTs) === "日期格式不對");
// 2026-09-16 兩筆真的寫進表格的錯資料
ok("GLPC 的「DAILY SCHEDULE」週賽擋掉",
  validateEvent(mk({ Tournament: "Grand Loyal DAILY SCHEDULE 14.9.2026---20.9.2026" }), todayTs) === "例行賽程不是錦標賽系列");
ok("「Quads Weekly」擋掉", validateEvent(mk({ Tournament: "Quads Weekly 14/09-20/09/2026" }), todayTs) === "例行賽程不是錦標賽系列");
ok("彙整站來的單日賽事擋掉（WSOP Paradise 被抽成 9/16 一天）",
  String(validateEvent(mk({ Tournament: "WSOP Paradise 2026", "Start Date": "2026-09-16", "End Date": "2026-09-16", _tier: 3 }), todayTs)).startsWith("彙整站的單日"));
ok("主辦站來的單日賽事不擋（T1 的資料可信）",
  validateEvent(mk({ Tournament: "One Day Special", "Start Date": "2026-10-01", "End Date": "2026-10-01", _tier: 1 }), todayTs) === null);
ok("名稱裡的 Daily 是單字才算（Dailymotion Cup 不會被誤擋）",
  validateEvent(mk({ Tournament: "Dailymotion Cup" }), todayTs) === null);

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

console.log("\n【10】模型下架時自動換模型（2026-09-08 真的發生過）");
const real404 = JSON.stringify({ error: { code: 404,
  message: "This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.6-flash for the latest features and improvements.",
  status: "NOT_FOUND" } });
eq("從真實的 404 訊息挑出接替模型", pickReplacementModel(real404, "gemini-2.5-flash"), "gemini-3.6-flash");
eq("訊息裡只提到自己 → 回 null（不會無限重試）",
  pickReplacementModel("models/gemini-3.6-flash not found", "gemini-3.6-flash"), null);
eq("訊息裡沒有模型名稱 → 回 null", pickReplacementModel("Not Found", "gemini-3.6-flash"), null);

console.log("\n【11】賽事名稱補品牌（JOPT 官網的卡片只寫「2026 Sapporo #02」）");
eq("名稱缺品牌 → 補在前面", applyBrand("2026 Sapporo #02", "JOPT"), "JOPT 2026 Sapporo #02");
eq("名稱已經有品牌 → 不重複加", applyBrand("JOPT 2027 Tokyo #01", "JOPT"), "JOPT 2027 Tokyo #01");
eq("品牌比對不分大小寫", applyBrand("jopt 2026 Osaka", "JOPT"), "jopt 2026 Osaka");
eq("來源沒設 brand → 原封不動", applyBrand("Manila Super Series 24", undefined), "Manila Super Series 24");
eq("品牌只是別的字的一部分 → 還是要補",
  applyBrand("Joptimism Cup", "JOPT"), "JOPT Joptimism Cup");

console.log("\n【12】賽期天數（過長的要在預覽標記提醒）");
eq("同一天 = 1 天", festivalDays({ "Start Date": "2026-10-01", "End Date": "2026-10-01" }), 1);
eq("10/01~10/30 = 30 天", festivalDays({ "Start Date": "2026-10-01", "End Date": "2026-10-30" }), 30);
eq("日期壞掉 → 0（不會誤標）", festivalDays({ "Start Date": "x", "End Date": "y" }), 0);

console.log("\n【13】Gemini 429：每分鐘上限可以等，每日上限不用等");
ok("訊息提到 PerDay → 判定為每日額度用完",
  isDailyQuotaError('{"message":"Quota exceeded for GenerateRequestsPerDayPerProjectPerModel"}'));
ok("訊息提到 PerMinute → 不是每日額度（還可以再等）",
  !isDailyQuotaError('{"message":"Quota exceeded for GenerateRequestsPerMinutePerProjectPerModel"}'));
ok("看不出是哪一種 → 當成每分鐘（保守，還會再試一次）", !isDailyQuotaError("Too Many Requests"));

console.log("\n【14】合併呼叫：把小頁面打包成幾批，省 Gemini 額度");
const mkItem = (name, len) => ({ src: { name, tier: 1 }, text: "x".repeat(len) });
const shape = (bs) => bs.map((b) => b.map((it) => it.src.name));

eq("五個小頁面 → 一批（未達上限）",
  shape(packBatches([1, 2, 3, 4, 5].map((n) => mkItem(`s${n}`, 1000)), 100000, 5)),
  [["s1", "s2", "s3", "s4", "s5"]]);
eq("六個小頁面 → 依每批數量上限切成 5+1",
  shape(packBatches([1, 2, 3, 4, 5, 6].map((n) => mkItem(`s${n}`, 1000)), 100000, 5)),
  [["s1", "s2", "s3", "s4", "s5"], ["s6"]]);
eq("字數超過上限就換下一批",
  shape(packBatches([mkItem("a", 60), mkItem("b", 60), mkItem("c", 10)], 100, 5)),
  [["a"], ["b", "c"]]);
eq("單一來源本身就超過上限 → 自己成一批，不會被丟掉",
  shape(packBatches([mkItem("huge", 500), mkItem("small", 10)], 100, 5)),
  [["huge"], ["small"]]);
eq("沒有來源 → 空陣列（不會產生空批次）", packBatches([], 100, 5), []);
ok("14 個真實大小的來源會壓成 3 批（原本要 14 次呼叫）",
  packBatches(
    [7256, 3383, 1480, 4406, 8199, 3358, 5385, 2720, 5749, 3404, 1755, 4746, 5520, 54992]
      .map((n, i) => mkItem(`s${i}`, n)), 120000, 5,
  ).length === 3);

console.log("\n【15】取消偵測：拆出取消標記，名稱要留乾淨的才比對得到表上那一列");
eq("PCA 的 ***CANCELLED*** 格式",
  stripCancelMark("***CANCELLED*** Poker Dream 27 Jeju"),
  { name: "Poker Dream 27 Jeju", cancelled: true });
eq("小寫、括號在後面（空括號要一起清掉）", stripCancelMark("Super Cup Seoul 9 2026 (cancelled)"),
  { name: "Super Cup Seoul 9 2026", cancelled: true });
eq("中文「已取消」", stripCancelMark("已取消 - APT Taipei 2026"),
  { name: "APT Taipei 2026", cancelled: true });
eq("正常賽事不動它", stripCancelMark("GOP Taipei 2026 II"),
  { name: "GOP Taipei 2026 II", cancelled: false });
eq("空字串", stripCancelMark(""), { name: "", cancelled: false });
ok("「Cancellation」不會被誤判成取消（只認完整的 cancelled/canceled）",
  stripCancelMark("Cancellation Policy Cup").cancelled === false);
ok("「Cancel」單字也不會誤判", stripCancelMark("Cancel Culture Open").cancelled === false);

console.log("\n【16】對回表格列：絕不能猜錯，猜錯就會改到別人的資料");
// 2026-09-09 的真實事故：LLM 分組失敗導致 matched 是空字串，findSheetRow("") 比對到
// 表格裡的空白列，結果第 16 列被寫進「[已取消]」。以下把這個洞釘死。
const sheetRows = [
  { _row: 2, Tournament: "APT JEJU 2026" },
  { _row: 16, Tournament: "" }, // 空白列
  { _row: 17, Tournament: "   " }, // 只有空白字元
  { _row: 20, Tournament: "GOP Incheon 2026 II" },
];
eq("空字串 → null（絕不比對到空白列）", findSheetRow("", sheetRows), null);
eq("undefined → null", findSheetRow(undefined, sheetRows), null);
eq("只有空白 → null", findSheetRow("   ", sheetRows), null);
eq("名稱太短 → null（寧可不改）", findSheetRow("AP", sheetRows), null);
eq("完全相同 → 對到那一列", findSheetRow("APT JEJU 2026", sheetRows)?._row, 2);
eq("名稱相近 → 對得到", findSheetRow("GOP Incheon 2026", sheetRows)?._row, 20);
eq("完全對不上 → null", findSheetRow("Some Unrelated Series 2026", sheetRows), null);

console.log("\n【17】地點寫成 Wei 手填的雙語格式");
// 對照組（實際從網站抓下來的既有列）：
//   "台灣 台北\nTaipei, Taiwan" / "韓國 濟州島\nJeju, Korea" / "馬來西亞 \nMalaysia"
eq("台北", formatLocation("Taipei, Taiwan"), "台灣 台北\nTaipei, Taiwan");
eq("濟州（英文用 Korea，跟既有列一致）", formatLocation("Jeju, South Korea"), "韓國 濟州島\nJeju, Korea");
eq("仁川", formatLocation("Incheon, South Korea"), "韓國 仁川\nIncheon, Korea");
eq("馬尼拉", formatLocation("Manila, Philippines"), "菲律賓 馬尼拉\nManila, Philippines");
eq("只有國家（沒城市）", formatLocation("Malaysia"), "馬來西亞 \nMalaysia");
eq("河內", formatLocation("Hanoi, Vietnam"), "越南 河內\nHanoi, Vietnam");
eq("澳門路氹", formatLocation("Cotai, Macau"), "澳門 路氹\nCotai, Macau");
eq("巴哈馬天堂島", formatLocation("Paradise, Bahamas"), "巴哈馬 天堂島\nParadise, Bahamas");
eq("城市國家同名 → 只寫國家（不要「新加坡 新加坡」）", formatLocation("Singapore, Singapore"), "新加坡 \nSingapore");
eq("澳洲：郊區對到城市（Southbank, Melbourne → 墨爾本）",
  formatLocation("Southbank, Melbourne, Australia"), "澳洲 墨爾本\nSouthbank, Melbourne, Australia");
eq("澳洲：Kogarah → 雪梨", formatLocation("Kogarah, Australia"), "澳洲 雪梨\nKogarah, Australia");
eq("澳洲：Surfers Paradise → 黃金海岸", formatLocation("Surfers Paradise, Australia"), "澳洲 黃金海岸\nSurfers Paradise, Australia");
eq("澳門, 澳門 同理", formatLocation("Macau, Macau"), "澳門 \nMacau");
eq("城市不在對照表 → 中文只寫國家，英文保留城市",
  formatLocation("Gangneung, South Korea"), "韓國 \nGangneung, Korea");
eq("國家不在對照表 → 原樣保留英文，不生半殘的雙語",
  formatLocation("Budva, Montenegro"), "Budva, Montenegro");
eq("空字串", formatLocation(""), "");

console.log("\n【18】買入金額的防線（2026-09-16 WWP 的保證獎金 TWD 1,000 萬被當成買入寫進表格）");
const B = { "ME Buy-in": "", Currency: "" };
eq("正常值（有原文佐證）", pickBuyIn({ me_buyin: 33000, currency: "twd", buyin_evidence: "主賽 Buy-in NT$33,000" }),
  { "ME Buy-in": "33000", Currency: "TWD" });
eq("沒附原文 → 留白（公開的數字寧可留白）", pickBuyIn({ me_buyin: 33000, currency: "TWD" }), B);
eq("WWP 那筆：原文是「保證獎金」→ 留白",
  pickBuyIn({ me_buyin: 10000000, currency: "TWD", buyin_evidence: "10/4 起 WWP S5 主賽正式開始 保證獎金 $ 10,000,000 NTD" }), B);
eq("TWD 1,000 萬就算原文寫 buy-in 也擋（≈ $31 萬，超過上限）",
  pickBuyIn({ me_buyin: 10000000, currency: "TWD", buyin_evidence: "buy-in NT$10,000,000" }), B);
eq("原文同時有 GTD 和 Buy-in → 信（數字本身另有上限把關）",
  pickBuyIn({ me_buyin: 33000, currency: "TWD", buyin_evidence: "Main Event NT$33,000 buy-in, NT$17M GTD" }),
  { "ME Buy-in": "33000", Currency: "TWD" });
eq("Triton $250k 超高額 → 在上限內，收",
  pickBuyIn({ me_buyin: 250000, currency: "USD", buyin_evidence: "$250,000 NLH Main Event buy-in" }),
  { "ME Buy-in": "250000", Currency: "USD" });
eq("VND 2,750 萬（≈ $1,080）→ 收", pickBuyIn({ me_buyin: 27500000, currency: "VND", buyin_evidence: "Buy-in 27.5M" }),
  { "ME Buy-in": "27500000", Currency: "VND" });
eq("KRW 6 億（≈ $43 萬）→ 擋", pickBuyIn({ me_buyin: 600000000, currency: "KRW", buyin_evidence: "buy-in 600,000,000" }), B);
eq("韓文原文「게런티」→ 擋", pickBuyIn({ me_buyin: 35000000, currency: "JPY", buyin_evidence: "메인 이벤트 게런티 35,000,000엔" }), B);
eq("不認識的幣別走舊的一億上限", pickBuyIn({ me_buyin: 5000, currency: "XYZ", buyin_evidence: "buy-in 5000" }),
  { "ME Buy-in": "5000", Currency: "XYZ" });
eq("沒填 → 留白", pickBuyIn({}), B);
eq("null → 留白", pickBuyIn({ me_buyin: null, currency: "TWD", buyin_evidence: "x" }), B);
eq("0 → 留白", pickBuyIn({ me_buyin: 0, currency: "TWD", buyin_evidence: "x" }), B);
eq("幣別不是三碼 → 留白", pickBuyIn({ me_buyin: 5000, currency: "NT$", buyin_evidence: "buy-in" }), B);
eq("有金額沒幣別 → 留白（換算不了就別寫）", pickBuyIn({ me_buyin: 5000, currency: "", buyin_evidence: "buy-in" }), B);

console.log("\n【19】系列官網後備連結（不依賴彙整站提供連結）");
const srcJson = JSON.parse(await readFile(new URL("./sources.json", import.meta.url), "utf8"));
const SL = srcJson.seriesLinks;
// 2026-09-10 那兩輪實際留白的賽事名，現在都該對得到官網
eq("KPC Poker Series October 2026", seriesLink("KPC Poker Series October 2026", SL),
  "https://www.kpcpoker.com/?lang=en");
eq("WPT Seoul 2026（2026-09-19 改指 /events/ 賽程頁）", seriesLink("WPT Seoul 2026", SL), "https://www.worldpokertour.com/events/");
eq("Triton SHRS Jeju II S5", seriesLink("Triton SHRS Jeju II S5", SL),
  "https://tritonpokerseries.com/en-US/events");
eq("USOP Grand Championship Vietnam 2026（首頁的內部連結全指向 userieschampionship.com，改指那邊的賽程總表）",
  seriesLink("USOP Grand Championship Vietnam 2026", SL), "https://userieschampionship.com/tournament/");
// Manila 的場館系列（Megastack／Super Series）改指 PokerStars Live Manila 的賽程頁：那裡才有日期和買入；
// APPT 本身還是指 APPT 官網
eq("Manila Megastack 25 → 場館賽程頁", seriesLink("Manila Megastack 25", SL), "https://www.pokerstarslivemanila.com/tournaments/");
eq("Manila Super Series 24 → 場館賽程頁", seriesLink("Manila Super Series 24", SL), "https://www.pokerstarslivemanila.com/tournaments/");
eq("APPT Championship → APPT 官網", seriesLink("APPT Championship", SL), "https://www.pokerstarslive.com/appt/");
eq("JOPT 2027 Fukuoka #01（補過品牌才對得到）", seriesLink("JOPT 2027 Fukuoka #01", SL),
  "https://japanopenpoker.com/");
eq("Jeju Poker Festival 2026 → Red Dragon（名稱沒有 RDPT 字樣）",
  seriesLink("Jeju Poker Festival 2026", SL), "https://playreddragon.com/series-schedule.html");
eq("GLPC Ultimate Showdown 2026（官網已更正為 grandloyal.vn）", seriesLink("GLPC Ultimate Showdown 2026", SL),
  "https://grandloyal.vn/");
eq("Quads Poker Championship Winter 2026", seriesLink("Quads Poker Championship Winter 2026", SL),
  "https://quadspoker.vn/series");
eq("RPT Championship Grand Final（官網已更正為 royal-poker.com）", seriesLink("RPT Championship Grand Final", SL),
  "https://royal-poker.com/en");
eq("AJPC Samurai Circuit - Incheon 2026 III", seriesLink("AJPC Samurai Circuit - Incheon 2026 III", SL),
  "https://samurai.ajpc.jp/en/");
eq("Poker Dream 26 Malaysia（2026-09-19 改指沒有人機驗證的新網域）",
  seriesLink("Poker Dream 26 Malaysia", SL), "https://www.poker-dream.com/en/tournaments");
eq("對照表沒有的系列 → 留空，不亂給連結",
  seriesLink("Super Cup 7 Incheon 2026", SL), "");
// 澳洲 vs 亞洲的縮寫撞名：APT / APL —— 靠地點的國家分辨
const AU = "Townsville, Australia", KR = "Jeju, South Korea";
eq("APL + 澳洲 → playapl（2026-09-16 真的填錯過：APL - The Ville 600 被填成韓國的）",
  seriesLink("APL - The Ville 600 - Townsville (QLD)", SL, AU), "https://playapl.com/");
eq("APL + 韓國 → Ace Poker League", seriesLink("APL Jeju 2026", SL, KR), "https://acepokerleague.com/");
eq("APL 沒給地點 → 退回沒限定的（韓國）", seriesLink("APL Jeju 2026", SL), "https://acepokerleague.com/");
eq("APT + 澳洲 → australianpokertour", seriesLink("APT Melbourne Champs", SL, AU), "https://australianpokertour.com.au/");
eq("APT + 韓國 → 亞洲的 APT", seriesLink("APT Jeju 2026", SL, KR), "https://www.theasianpokertour.com/series");
eq("Australian Poker Tour 全名 + 澳洲", seriesLink("Australian Poker Tour - Melbourne Champs II (VIC)", SL, AU),
  "https://australianpokertour.com.au/");
eq("APLPT + 澳洲", seriesLink("APLPT – Brisbane – Broncos Club (QLD)", SL, AU), "https://playapl.com/");
eq("地點是雙語格式也能認出國家", seriesLink("APL Cup", SL, "澳洲 雪梨\nSydney, Australia"), "https://playapl.com/");
eq("Aussie Millions → Crown", seriesLink("2027 Aussie Millions - Crown Melbourne", SL),
  "https://www.crownmelbourne.com.au/casino/table-games/poker");
eq("空名稱 → 留空", seriesLink("", SL), "");
ok("每個系列的網址都不是彙整站",
  SL.every((e) => !/pokercalendar\.asia|somuchpoker\.com|thehendonmob\.com/i.test(e.url)));

console.log("\n【20】回頭補既有列的空欄位（賽程表和報名費是後來才公布的）");
const cols = (fs) => fs.map((f) => f.col).sort();
const sheetOld = {
  _row: 88, Tournament: "KPC Poker Series October 2026",
  "Start Date": "2026-10-10", "End Date": "2026-10-21",
  Location: "Jeju, South Korea", "ME Buy-in": "", Currency: "", "Handbook URL": "",
};
const fresh = {
  Tournament: "KPC Series October 2026", Location: "Jeju, South Korea",
  "ME Buy-in": "1500000", Currency: "KRW", "Handbook URL": "https://www.kpcpoker.com/?lang=en",
};
eq("三種都補：買入＋幣別＋連結＋地點升級",
  cols(detectBlankFills(fresh, sheetOld)),
  ["Currency", "Handbook URL", "Location", "ME Buy-in"].sort());
eq("補上的地點是雙語格式",
  detectBlankFills(fresh, sheetOld).find((f) => f.col === "Location")?.value,
  "韓國 濟州島\nJeju, Korea");

const sheetFilled = { ...sheetOld, "ME Buy-in": "999", Currency: "USD", "Handbook URL": "https://wei-picked.example/", Location: "韓國 濟州島\nJeju, Korea" };
eq("已經有值的一個都不補（不覆蓋 Wei 手填的）", detectBlankFills(fresh, sheetFilled), []);

eq("只有金額沒幣別 → 兩個都不補（換算不了）",
  detectBlankFills({ ...fresh, Currency: "" }, sheetOld).some((f) => f.col === "ME Buy-in"), false);
// 新資料的買入和連結也是空的時候，只做地點格式升級——那不需要新資料，
// 是拿舊值本身換個寫法，跟買入有沒有公布無關
eq("新資料沒有買入也沒有連結 → 只升級地點",
  cols(detectBlankFills({ Location: "Jeju, South Korea" }, sheetOld)), ["Location"]);
eq("新舊都沒有可補的 → 空陣列",
  detectBlankFills({ Location: "" }, { ...sheetOld, Location: "韓國 濟州島\nJeju, Korea" }), []);
eq("對不到列 → 不補", detectBlankFills(fresh, null), []);

// 地點升級的安全線：只有確認是同一個地方才換寫法
eq("地點指的不是同一個地方 → 不動它",
  detectBlankFills({ ...fresh, Location: "Seoul, South Korea" }, sheetOld)
    .some((f) => f.col === "Location"), false);
eq("舊值已經有中文 → 不動它",
  detectBlankFills(fresh, { ...sheetOld, Location: "韓國 濟州島\nJeju, Korea" })
    .some((f) => f.col === "Location"), false);
eq("補上的欄位帶著列號", detectBlankFills(fresh, sheetOld)[0]?.row, 88);

// 連結升級（2026-09-19）：表上只是系列首頁這種泛用連結時，主辦方／場館方給的專屬頁可以換上去。
// Poker Dream 26、Manila Super Series 24 的買入官網都有，就是卡在表上的連結只到首頁，詳情頁抓不到東西。
const GL = new Set(["https://www.pokerstarslive.com/appt/", "https://pokerdream-live.com/", "https://www.poker-dream.com/en/tournaments", "https://godsofpoker.com/series"].map(normalizeLink));
const manilaRow = { ...sheetOld, _row: 78, Tournament: "Manila Super Series 24", "Handbook URL": "https://www.pokerstarslive.com/appt/", Location: "菲律賓 馬尼拉\nManila, Philippines" };
const venue = { Tournament: "Manila Super Series 24", Location: "Manila, Philippines", "ME Buy-in": "", Currency: "",
  "Handbook URL": "https://www.pokerstarslivemanila.com/tournaments/superseries24/", _linkTier: 2, _linkHost: "pokerstarslivemanila.com" };
const up = detectBlankFills(venue, manilaRow, GL);
eq("泛用連結 + 場館方給專屬頁 → 升級", up.map((f) => [f.col, f.value, f.why]),
  [["Handbook URL", "https://www.pokerstarslivemanila.com/tournaments/superseries24/", "升級為專屬連結"]]);
eq("專屬頁來自彙整站（T3）→ 不升級", detectBlankFills({ ...venue, _linkTier: 3 }, manilaRow, GL), []);
eq("表上是 Wei 手填的專屬連結 → 不動", detectBlankFills(venue, { ...manilaRow, "Handbook URL": "https://www.pokerstarslive.com/appt/manila/" }, GL), []);
eq("新的也只是泛用連結 → 不換", detectBlankFills({ ...venue, "Handbook URL": "https://godsofpoker.com/series" }, manilaRow, GL), []);
eq("新連結不在來源網站也不在舊連結的網站 → 不換（防 AI 撿到贊助商連結）",
  detectBlankFills({ ...venue, "Handbook URL": "https://sponsor.example/promo" }, manilaRow, GL), []);
eq("新連結跟舊連結同網站也算（APPT 首頁 → APPT 專頁）",
  detectBlankFills({ ...venue, "Handbook URL": "https://www.pokerstarslive.com/appt/manila/", _linkHost: "somewhere-else.example" }, manilaRow, GL).length, 1);
eq("一樣的連結（只差 www／斜線）→ 不算升級", detectBlankFills({ ...venue, "Handbook URL": "https://pokerstarslive.com/appt" }, manilaRow, GL), []);
eq("沒傳泛用集合 → 一律當成非泛用，不升級", detectBlankFills(venue, manilaRow), []);
// 以前寫錯的連結（linkFixes 左邊的值）也算泛用：主辦方給專屬頁時直接升級，不必先等更正再等一輪
const pdRow = { ...sheetOld, _row: 67, Tournament: "Poker Dream 26", "Handbook URL": "https://pokerdream-live.com/", Location: "馬來西亞 雲頂\nGenting Highlands, Malaysia" };
const pd = { Tournament: "POKER DREAM 26 MALAYSIA", Location: "Genting Highlands, Malaysia", "ME Buy-in": "", Currency: "",
  "Handbook URL": "https://www.poker-dream.com/tournaments/73e51667-81e4-418a-9cad-17d5ecc012d2", _linkTier: 1, _linkHost: "poker-dream.com" };
eq("舊網域的錯連結 → 直接升級成新網域的專屬頁", detectBlankFills(pd, pdRow, GL).map((f) => f.why), ["升級為專屬連結"]);

console.log("\n【20b】連結工具：正規化、泛用連結、同網站判定");
eq("正規化：http/https、www、結尾斜線、大小寫都不算差異", normalizeLink("HTTP://WWW.PokerStarsLive.com/appt/"), "pokerstarslive.com/appt");
const srcGeneric = new Set();
for (const e of srcJson.seriesLinks) srcGeneric.add(normalizeLink(e.url));
for (const s of srcJson.sources) srcGeneric.add(normalizeLink(s.url));
for (const [k, v] of Object.entries(srcJson.linkFixes)) { srcGeneric.add(normalizeLink(k)); srcGeneric.add(normalizeLink(typeof v === "string" ? v : v.to)); }
ok("系列官網首頁是泛用連結", isGenericLink("https://www.pokerstarslive.com/appt/", srcGeneric));
ok("來源列表頁是泛用連結", isGenericLink("https://ctpclub.app/festivals", srcGeneric));
ok("以前寫錯的連結（更正表左邊）是泛用連結", isGenericLink("https://pokerdream-live.com/", srcGeneric));
ok("賽事專屬頁不是泛用連結", !isGenericLink("https://www.pokerstarslivemanila.com/tournaments/superseries24/", srcGeneric));
ok("GOP 的專屬頁不是泛用連結", !isGenericLink("https://godsofpoker.com/series/taipei-2026-ii", srcGeneric));
ok("空字串不是泛用連結", !isGenericLink("", srcGeneric));
ok("同網站：子網域算同一個", sameDomain("https://events.japanopenpoker.com/2026-tokyo-03", "https://japanopenpoker.com/"));
ok("同網站：主機名 vs 網址也能比", sameDomain("https://www.poker-dream.com/tournaments/x", "poker-dream.com"));
ok("不同網站：poker-dream.com vs pokerdream-live.com", !sameDomain("https://www.poker-dream.com/", "https://pokerdream-live.com/"));
ok("二級後綴：winwinpoker.com.tw 和 other.com.tw 不是同一個", !sameDomain("https://winwinpoker.com.tw/", "https://other.com.tw/"));
ok("二級後綴：同一個 .com.tw 網站的內頁算同一個", sameDomain("https://winwinpoker.com.tw/s5", "https://www.winwinpoker.com.tw/"));
ok("壞掉的網址 → false 不會爆", !sameDomain("not a url", "https://x.example/"));
eq("hostOf 去掉 www", hostOf("https://www.kpcpoker.com/?lang=en"), "kpcpoker.com");

console.log("\n【21】詳情頁要抓哪些：新增的優先，再來是 3 個月內開賽、買入還空的既有列");
const T0 = Date.parse("2026-09-11T00:00:00+08:00");
const day = (n) => new Date(T0 + n * 86400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
const ex = (row, t, start, buyin = "", url = "") => ({
  _row: row, Tournament: t, "Start Date": day(start), "End Date": day(start + 7), "ME Buy-in": buyin, "Handbook URL": url,
});
const existingRows = [
  ex(10, "Soon Blank", 20, "", "https://a.example/"),        // 20 天後開賽、買入空 → 要抓
  ex(11, "Sooner Blank", 5, "", "https://b.example/"),       // 5 天後 → 要抓，而且排最前面
  ex(12, "Far Blank", 120, "", "https://c.example/"),        // 120 天後 → 超過 3 個月，不抓
  ex(13, "Soon Filled", 15, "35000", "https://d.example/"),  // 買入已有 → 不抓
  ex(14, "Soon NoUrl", 10, "", ""),                          // 沒連結 → 抓不了
  ex(15, "Ended", -30, "", "https://e.example/"),            // 已結束 → 不抓
  ex(16, "[已取消] Soon", 12, "", "https://f.example/"),      // 已取消 → 不抓
  ex(17, "Pending Url", 8, "", ""),                          // 這輪剛排入要補的連結 → 用那個
  ex(18, "Upgraded Url", 9, "", "https://old-generic.example/"), // 表上有舊連結，但這輪排入了更好的 → 用新的
];
const pending = [
  { row: 17, col: "Handbook URL", value: "https://g.example/" },
  { row: 18, col: "Handbook URL", value: "https://new-specific.example/", why: "升級為專屬連結" },
];
const newRows = [
  { Tournament: "New A", "Handbook URL": "https://n1.example/", "ME Buy-in": "" },
  { Tournament: "New B", "Handbook URL": "https://n2.example/", "ME Buy-in": "5000" }, // 列表頁已抓到 → 不用
  { Tournament: "New C", "Handbook URL": "", "ME Buy-in": "" },                          // 沒連結 → 抓不了
];
const tg = detailTargets(newRows, existingRows, pending, T0);
eq("順序：新增的在前，既有列依開賽日由近到遠",
  tg.map((t) => t.name), ["New A", "Sooner Blank", "Pending Url", "Upgraded Url", "Soon Blank"]);
eq("已有買入 / 沒連結 / 太遠 / 已結束 / 已取消 都不在清單裡",
  tg.some((t) => /Filled|NoUrl|Far|Ended|取消|New B|New C/.test(t.name)), false);
eq("這輪剛排入要補的連結也算數", tg.find((t) => t.name === "Pending Url")?.url, "https://g.example/");
eq("這輪排入的更正／升級連結優先於表上的舊連結", tg.find((t) => t.name === "Upgraded Url")?.url, "https://new-specific.example/");
eq("新增列帶著 ev 物件（結果要寫回去）", tg[0].kind === "new" && tg[0].ev?.Tournament, "New A");
eq("既有列帶著 row 物件（要知道寫第幾列）", tg[1].kind === "existing" && tg[1].row?._row, 11);
eq("沒有任何目標 → 空陣列", detailTargets([], [], [], T0), []);

console.log("\n【22】Google Sheets 錯誤：暫時性的重試，權限／資料錯誤不重試");
ok("ECONNRESET（2026-09-14 週一排程實際遇到的）→ 重試",
  isTransientSheetsError(new Error("request to https://sheets.googleapis.com/... failed, reason: read ECONNRESET")));
ok("ETIMEDOUT → 重試", isTransientSheetsError({ message: "connect ETIMEDOUT", code: "ETIMEDOUT" }));
ok("socket hang up → 重試", isTransientSheetsError(new Error("socket hang up")));
ok("HTTP 503 → 重試", isTransientSheetsError({ message: "Service Unavailable", response: { status: 503 } }));
ok("HTTP 429 → 重試", isTransientSheetsError({ message: "Too Many Requests", response: { status: 429 } }));
ok("HTTP 403 權限錯誤 → 不重試（重試也不會變有權限）",
  !isTransientSheetsError({ message: "The caller does not have permission", response: { status: 403 } }));
ok("HTTP 400 資料錯誤 → 不重試", !isTransientSheetsError({ message: "Invalid range", response: { status: 400 } }));
ok("HTTP 404 → 不重試", !isTransientSheetsError({ message: "Requested entity was not found", response: { status: 404 } }));
ok("欄位對不上的中止訊息 → 不重試",
  !isTransientSheetsError(new Error("分頁缺少必要欄位「Start Date」— 是不是接錯分頁了？")));

console.log("\n【23】更正爬蟲以前寫錯的連結（只認一模一樣的值，不碰 Wei 手填的）");
const LF = srcJson.linkFixes;
const sheetLinks = [
  { _row: 88, Tournament: "RPT Championship IV", "Handbook URL": "https://royalpokerclub.vn/" },      // 爬蟲寫錯的 → 要改
  { _row: 92, Tournament: "RPT Grand Final", "Handbook URL": "https://royalpokerclub.vn/ " },        // 尾端多空白也要認得
  { _row: 63, Tournament: "GOP Taipei", "Handbook URL": "https://godsofpoker.com/series/taipei-2026-ii" }, // 正確的 → 不動
  { _row: 70, Tournament: "Wei 手填", "Handbook URL": "https://royalpokerclub.vn/some-page" },       // 只是前綴相同 → 不動
  { _row: 75, Tournament: "空的", "Handbook URL": "" },                                              // 空的 → 不動（那是補空白的事）
];
const fx = detectLinkFixes(sheetLinks, LF);
eq("只有一模一樣的兩筆被更正", fx.map((f) => f.row).sort(), [88, 92]);
eq("更正成官網", fx[0]?.value, "https://royal-poker.com/en");
eq("前綴相同但不完全一樣的不動", fx.some((f) => f.row === 70), false);
eq("沒有更正表 → 空陣列", detectLinkFixes(sheetLinks, {}), []);
// 條件式更正：同一個錯值只對某些國家的列才算錯
const mixed = [
  { _row: 101, Tournament: "APL - The Ville 600", Location: "澳洲 湯斯維爾\nTownsville, Australia", "Handbook URL": "https://acepokerleague.com/" },
  { _row: 102, Tournament: "APL Jeju 2026", Location: "韓國 濟州島\nJeju, Korea", "Handbook URL": "https://acepokerleague.com/" },
];
const cond = detectLinkFixes(mixed, LF);
eq("澳洲那列被更正成 playapl", cond.find((f) => f.row === 101)?.value, "https://playapl.com/");
eq("韓國那列不動（對它來說 acepokerleague 是對的）", cond.some((f) => f.row === 102), false);
eq("更正表是 undefined 也不會爆", detectLinkFixes(sheetLinks, undefined), []);
// 2026-09-19 查明的三個錯連結
const wrong3 = [
  { _row: 67, Tournament: "Poker Dream 26", "Handbook URL": "https://pokerdream-live.com/" },
  { _row: 96, Tournament: "AJPC Samurai Circuit – Incheon 2026 III", "Handbook URL": "https://ajpc-ac.com/en/" },
  { _row: 66, Tournament: "APPT Championship", "Handbook URL": "http://www.okadamanila.com/" },
];
eq("Poker Dream 舊網域 → 新網域", detectLinkFixes(wrong3, LF).find((f) => f.row === 67)?.value, "https://www.poker-dream.com/en/tournaments");
eq("ajpc-ac.com（網域已死）→ samurai.ajpc.jp", detectLinkFixes(wrong3, LF).find((f) => f.row === 96)?.value, "https://samurai.ajpc.jp/en/");
eq("okadamanila.com（賭場首頁）→ PokerStars Live Manila 賽程頁", detectLinkFixes(wrong3, LF).find((f) => f.row === 66)?.value, "https://www.pokerstarslivemanila.com/tournaments/");
ok("更正的值本身不是彙整站", Object.values(LF).every((v) => !/pokercalendar\.asia|somuchpoker\.com/i.test(v)));

console.log("\n【24】哪些網域要用真瀏覽器（內容靠 JS 載入的）");
const BH = new Set(srcJson.browserHosts);
ok("RPT 官網 → 瀏覽器", needsBrowser("https://royal-poker.com/en", BH));
ok("Red Dragon 內頁 → 瀏覽器（含 www）", needsBrowser("https://www.playreddragon.com/RDPT/jeju-2026.html", BH));
ok("子網域也算", needsBrowser("https://live.tritonpokerseries.com/x", BH));
ok("APT 官網 → 純 fetch 就好", !needsBrowser("https://www.theasianpokertour.com/series", BH));
ok("Poker Dream 新網域 → 瀏覽器", needsBrowser("https://www.poker-dream.com/tournaments/x", BH));
ok("WPT → 瀏覽器（純 fetch 403）", needsBrowser("https://www.worldpokertour.com/events/", BH));
ok("Poker Dream 舊網域不在名單（有人機驗證，不繞）", !needsBrowser("https://pokerdream-live.com/", BH));
ok("PokerStars Live Manila → 純 fetch 就好", !needsBrowser("https://www.pokerstarslivemanila.com/tournaments/", BH));
ok("壞掉的網址 → false 不會爆", !needsBrowser("not a url", BH));
ok("每個瀏覽器來源的網域都在 browserHosts 裡",
  srcJson.sources.filter((s) => s.browser).every((s) => needsBrowser(s.url, BH)));

console.log("\n【25】待補清單：買入抓不到的列 + 為什麼");
const T1 = Date.parse("2026-09-16T00:00:00+08:00");
const d = (n) => new Date(T1 + n * 86400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
const mkRow = (row, t, start, extra = {}) => ({
  _row: row, Tournament: t, "Start Date": d(start), "End Date": d(start + 7),
  "ME Buy-in": "", Location: "韓國 濟州島\nJeju, Korea", "Handbook URL": "", ...extra,
});
const rowsForTodo = [
  mkRow(10, "Has BuyIn", 5, { "ME Buy-in": "1000" }),                       // 有買入 → 不列
  mkRow(11, "Filled This Run", 5, { "Handbook URL": "https://a.example/" }), // 這輪剛補到 → 不列
  mkRow(12, "[已取消] Gone", 5, { "Handbook URL": "https://a.example/" }),   // 已取消 → 不列
  mkRow(13, "Ended", -30, { "Handbook URL": "https://a.example/" }),         // 已結束 → 不列
  mkRow(14, "No Link", 5),                                                   // 沒連結
  mkRow(15, "Poker Dream 28", 5, { "Handbook URL": "https://pokerdream-live.com/" }), // 人機驗證
  mkRow(16, "RPT Something", 5, { "Handbook URL": "https://royal-poker.com/en" }),    // 這輪：頁面沒列
  mkRow(17, "Blocked", 5, { "Handbook URL": "https://okada.example/" }),              // 這輪：連不上
  mkRow(18, "Far Future", 200, { "Handbook URL": "https://a.example/" }),             // 太遠
  mkRow(19, "Not Reached", 40, { "Handbook URL": "https://a.example/" }),             // 沒輪到
  mkRow(20, "Pending Link", 5),                                                        // 這輪剛排入連結但沒抓到買入
];
const fills = [
  { row: 11, col: "ME Buy-in", value: "500" }, { row: 11, col: "Currency", value: "USD" },
  { row: 20, col: "Handbook URL", value: "https://b.example/" },
];
const outcome = new Map([[16, "官網頁面沒列主賽買入"], [17, "從 GitHub 連不上官網（HTTP 403），可能擋機房 IP"]]);
const todo = buildTodoList(rowsForTodo, fills, outcome, T1);
const byRow = Object.fromEntries(todo.map((t) => [t.row, t.why]));
eq("列出的是這幾筆", todo.map((t) => t.row).sort((a, b) => a - b), [14, 15, 16, 17, 18, 19, 20]);
ok("沒連結 → 說要補連結", /沒有官網連結/.test(byRow[14]));
ok("人機驗證的網域 → 說要人工", /人機驗證|要登入/.test(byRow[15]));
eq("這輪抓過但頁面沒列 → 照實說", byRow[16], "官網頁面沒列主賽買入");
ok("這輪連不上 → 說可能擋 IP", /連不上/.test(byRow[17]));
ok("開賽還早 → 說之後會自動抓", /開賽還早/.test(byRow[18]));
ok("沒輪到 → 說下次再試", /下次再試/.test(byRow[19]));
ok("這輪剛排入連結的也算有連結（不會說沒連結）", !/沒有官網連結/.test(byRow[20]));
ok("依開賽日排序", todo.every((t, i) => i === 0 || todo[i - 1].start <= t.start));
eq("地點只取中文那行", todo[0].location, "韓國 濟州島");
eq("空表 → 空清單", buildTodoList([], [], new Map(), T1), []);
eq("表上是舊錯連結、這輪排入了更正 → 清單上顯示更正後的",
  buildTodoList([mkRow(21, "PD 26", 5, { "Handbook URL": "https://pokerdream-live.com/" })],
    [{ row: 21, col: "Handbook URL", value: "https://www.poker-dream.com/en/tournaments" }], new Map(), T1)[0]?.link,
  "https://www.poker-dream.com/en/tournaments");

console.log("\n【26】賽程 PDF：從頁面連結裡挑出最像賽程表的（KPC／Red Dragon／USOP 的買入只在 PDF 裡）");
ok("isPdfUrl：.pdf 結尾", isPdfUrl("https://a.example/x/schedule.pdf"));
ok("isPdfUrl：.pdf 後面接參數也算", isPdfUrl("https://a.example/x/schedule.PDF?v=2"));
ok("isPdfUrl：.pdfx 不算", !isPdfUrl("https://a.example/x/schedule.pdfx"));
ok("isPdfUrl：一般網頁不算", !isPdfUrl("https://a.example/schedule"));
// KPC：pdf.js 檢視器包住檔案，真正的 PDF 在 file 參數裡（相對路徑）
const kpcText = "Series [link:https://www.kpcpoker.com/thirdparty/pdfjs/web/viewer.html?file=/u/cms/en/202609/08112324pobw.pdf] [link:https://www.kpcpoker.com/seriesImage/42632.jhtml] News";
eq("KPC 檢視器連結 → 拆出真正的 PDF 網址", findPdfLinks(kpcText), ["https://www.kpcpoker.com/u/cms/en/202609/08112324pobw.pdf"]);
// USOP：英／日／中三份賽程 + 兩份政策文件 → 英文賽程第一，政策不要
const usopText = [
  "[link:https://u.example/wp-content/uploads/2026/09/USC-Osaka-October-schedule-CN.pdf] EVENT SCHEDULE (CN)",
  "[link:https://u.example/wp-content/uploads/2025/09/USOP-Player-Protection-and-Liability-Policy-FA.pdf] PLAYER PROTECTION & LIABILTY",
  "[link:https://u.example/wp-content/uploads/2026/09/USC-Osaka-October-schedule-ENG.pdf] EVENT SCHEDULE (EN)",
  "[link:https://u.example/wp-content/uploads/2026/09/USC-Osaka-October-schedule-JP.pdf] EVENT SCHEDULE (JP)",
  "[link:https://u.example/guide/USOP-Players-Guide-EN.pdf] PLAYERS GUIDE (EN)",
].join(" ");
const usopPdfs = findPdfLinks(usopText);
eq("英文賽程排第一", usopPdfs[0], "https://u.example/wp-content/uploads/2026/09/USC-Osaka-October-schedule-ENG.pdf");
ok("政策、指南文件不在清單裡", usopPdfs.every((u) => !/Policy|Guide/.test(u)));
eq("三份賽程都在（日中排後面）", usopPdfs.length, 3);
// Red Dragon 系列頁：Oct–Nov 賽程 vs 夏季那份（檔名沒有 schedule）
const rdText = "[link:https://playreddragon.com/pdf/17-24-summer2026-compressed.pdf] [img:RDPT Plus Jeju Summer 2026] [link:https://playreddragon.com/pdf/October-November-Schedule-2026.pdf] [img:Jeju Poker Festival 2026]";
eq("有 schedule 字樣的排前面，另一份也保留當備案", findPdfLinks(rdText),
  ["https://playreddragon.com/pdf/October-November-Schedule-2026.pdf", "https://playreddragon.com/pdf/17-24-summer2026-compressed.pdf"]);
eq("連結文字有 schedule 也算（檔名看不出來）", findPdfLinks("[link:https://a.example/files/2026-10.pdf] Tournament Schedule [link:https://a.example/files/rules.pdf] Rules"),
  ["https://a.example/files/2026-10.pdf"]);
eq("同一份只算一次（www／斜線差異）", findPdfLinks("[link:https://www.a.example/s.pdf] x [link:https://a.example/s.pdf] y").length, 1);
eq("沒有 PDF → 空陣列", findPdfLinks("[link:https://a.example/series] Series [link:https://a.example/news] News"), []);
eq("空字串不會爆", findPdfLinks(""), []);

console.log(`\n${"─".repeat(50)}\n通過 ${pass}｜失敗 ${fail}`);
process.exit(fail ? 1 : 0);

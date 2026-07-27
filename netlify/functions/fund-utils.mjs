const FUND_SEARCH_URL = "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx";
const NAV_URL = "https://fundf10.eastmoney.com/F10DataApi.aspx";

export function jsonResponse(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

export function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

function buildUrl(url, params) {
  const target = new URL(url);
  Object.entries(params).forEach(([key, value]) => {
    target.searchParams.set(key, value);
  });
  return target.toString();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      referer: "https://fund.eastmoney.com/",
    },
  });
  if (!response.ok) {
    throw new Error(`数据源响应异常：${response.status}`);
  }
  return response.text();
}

function parseDateText(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
    throw new Error("日期格式应为 YYYY-MM-DD");
  }
  return value;
}

function dateToDays(value) {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function cleanNumber(value) {
  const normalized = String(value || "").replace(/,/g, "").trim();
  if (!normalized || normalized === "--") return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function decodeContentHtml(text) {
  const match = text.match(/content:"([\s\S]*?)",records:/);
  if (!match) {
    throw new Error("没有获取到净值表格，请稍后再试");
  }
  return match[1].replace(/\\"/g, '"').replace(/\\\//g, "/");
}

function parseNavRows(html) {
  const rows = [];
  const rowPattern = /<tr><td>(\d{4}-\d{2}-\d{2})<\/td><td[^>]*>([^<]*)<\/td><td[^>]*>([^<]*)<\/td><td[^>]*>([^<]*)<\/td>/g;
  let match;
  while ((match = rowPattern.exec(html))) {
    const unitNav = cleanNumber(match[2]);
    const accumulatedNav = cleanNumber(match[3]);
    if (unitNav === null || accumulatedNav === null) continue;
    rows.push({
      date: match[1],
      unitNav,
      accumulatedNav,
      dailyChange: match[4],
    });
  }
  return rows;
}

async function fetchNavPage(code, startDate, endDate, page, perPage) {
  const text = await fetchText(
    buildUrl(NAV_URL, {
      type: "lsjz",
      code,
      page: String(page),
      per: String(perPage),
      sdate: startDate,
      edate: endDate,
    })
  );
  const meta = text.match(/records:(\d+),pages:(\d+),curpage:(\d+)/);
  const totalPages = meta ? Math.max(1, Number(meta[2])) : 1;
  return {
    rows: parseNavRows(decodeContentHtml(text)),
    totalPages,
  };
}

export async function searchFunds(keyword) {
  const text = await fetchText(buildUrl(FUND_SEARCH_URL, { m: "1", key: keyword }));
  const data = JSON.parse(text);
  return (data.Datas || [])
    .filter((item) => item.CATEGORYDESC === "基金" && item.FundBaseInfo)
    .slice(0, 12)
    .map((item) => ({
      code: item.CODE,
      name: item.NAME,
      type: item.FundBaseInfo.FTYPE || "",
      company: item.FundBaseInfo.JJGS || "",
      latestNav: item.FundBaseInfo.DWJZ,
      latestDate: item.FundBaseInfo.FSRQ,
    }));
}

export async function calculateAnnualized(code, buyDateText, navTypeText) {
  if (!/^\d{6}$/.test(code || "")) {
    throw new Error("基金代码应为 6 位数字");
  }

  const buyDate = parseDateText(buyDateText);
  const today = todayInShanghai();
  if (dateToDays(buyDate) >= dateToDays(today)) {
    throw new Error("买入日期需要早于今天");
  }

  const navType = navTypeText === "unit" ? "unit" : "accumulated";
  const perPage = 49;
  const firstPage = await fetchNavPage(code, buyDate, today, 1, perPage);
  const rows = [...firstPage.rows];

  if (firstPage.totalPages > 1) {
    const pageNumbers = Array.from(
      { length: firstPage.totalPages - 1 },
      (_, index) => index + 2
    );
    const pages = await Promise.all(
      pageNumbers.map((page) => fetchNavPage(code, buyDate, today, page, perPage))
    );
    pages.forEach((page) => rows.push(...page.rows));
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 2) {
    throw new Error("这个日期范围内净值数据不足，无法计算年化收益率");
  }

  const valueKey = navType === "accumulated" ? "accumulatedNav" : "unitNav";
  const start = rows[0];
  const end = rows[rows.length - 1];
  const elapsedDays = dateToDays(end.date) - dateToDays(start.date);
  if (elapsedDays <= 0) {
    throw new Error("持有天数不足，无法计算年化收益率");
  }

  const totalReturn = end[valueKey] / start[valueKey] - 1;
  const annualizedReturn = Math.pow(end[valueKey] / start[valueKey], 365 / elapsedDays) - 1;

  return {
    code,
    navType,
    requestedBuyDate: buyDate,
    startDate: start.date,
    endDate: end.date,
    startNav: start[valueKey],
    endNav: end[valueKey],
    elapsedDays,
    totalReturn,
    annualizedReturn,
    series: rows,
  };
}

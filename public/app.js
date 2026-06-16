const queryInput = document.querySelector("#fund-query");
const buyDateInput = document.querySelector("#buy-date");
const purchaseAmountInput = document.querySelector("#purchase-amount");
const suggestions = document.querySelector("#suggestions");
const form = document.querySelector("#calculator-form");
const emptyState = document.querySelector("#empty-state");
const loadingState = document.querySelector("#loading-state");
const errorState = document.querySelector("#error-state");
const resultState = document.querySelector("#result-state");
const chart = document.querySelector("#nav-chart");
let lastResult = null;
let fundCatalogPromise = null;
let providerScriptId = 0;

const FUND_CATALOG_URL = "https://fund.eastmoney.com/js/fundcode_search.js";
const NAV_URL = "https://fundf10.eastmoney.com/F10DataApi.aspx";

const selectedFund = {
  code: "",
  name: "",
  type: "",
  company: "",
};

buyDateInput.max = new Date(Date.now() - 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

function debounce(fn, delay = 280) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function formatPercent(value) {
  const percent = value * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function formatNav(value) {
  return Number(value).toFixed(4);
}

function formatMoney(value) {
  return `¥${Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function setState(state, message = "") {
  emptyState.classList.toggle("hidden", state !== "empty");
  loadingState.classList.toggle("hidden", state !== "loading");
  errorState.classList.toggle("hidden", state !== "error");
  resultState.classList.toggle("hidden", state !== "result");
  if (state === "error") {
    errorState.textContent = message;
  }
}

function friendlyFetchError(error) {
  return error.message || "请求失败，请稍后再试。";
}

function loadProviderGlobal(url, globalName) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const separator = url.includes("?") ? "&" : "?";
    const timeout = window.setTimeout(() => {
      script.remove();
      reject(new Error("数据源响应超时，请稍后重试。"));
    }, 18000);

    window[globalName] = undefined;
    script.src = `${url}${separator}_=${Date.now()}_${providerScriptId++}`;
    script.async = true;
    script.onload = () => {
      window.clearTimeout(timeout);
      script.remove();
      if (window[globalName] === undefined) {
        reject(new Error("数据源返回格式异常，请稍后重试。"));
        return;
      }
      resolve(window[globalName]);
    };
    script.onerror = () => {
      window.clearTimeout(timeout);
      script.remove();
      reject(new Error("连接基金数据源失败，请检查网络后重试。"));
    };
    document.head.appendChild(script);
  });
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[（）()\s]/g, "");
}

async function getFundCatalog() {
  if (!fundCatalogPromise) {
    fundCatalogPromise = loadProviderGlobal(FUND_CATALOG_URL, "r");
  }
  return fundCatalogPromise;
}

async function searchFundCatalog(keyword) {
  const normalized = normalizeText(keyword);
  const catalog = await getFundCatalog();
  if (!Array.isArray(catalog)) {
    throw new Error("基金列表数据格式异常，请稍后重试。");
  }

  return catalog
    .filter((item) => {
      const code = normalizeText(item[0]);
      const abbr = normalizeText(item[1]);
      const name = normalizeText(item[2]);
      const pinyin = normalizeText(item[4]);
      return (
        code.includes(normalized) ||
        name.includes(normalized) ||
        abbr.includes(normalized) ||
        pinyin.includes(normalized)
      );
    })
    .slice(0, 12)
    .map((item) => ({
      code: item[0],
      name: item[2],
      type: item[3] || "基金",
      company: "",
    }));
}

function todayText() {
  const now = new Date();
  const shanghaiNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const year = shanghaiNow.getFullYear();
  const month = String(shanghaiNow.getMonth() + 1).padStart(2, "0");
  const day = String(shanghaiNow.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateDays(value) {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function cleanNumber(value) {
  const number = Number(String(value || "").replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : null;
}

function parseNavRows(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  return [...template.content.querySelectorAll("tbody tr")]
    .map((row) => {
      const cells = [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim());
      const unitNav = cleanNumber(cells[1]);
      const accumulatedNav = cleanNumber(cells[2]);
      if (!cells[0] || unitNav === null || accumulatedNav === null) return null;
      return {
        date: cells[0],
        unitNav,
        accumulatedNav,
        dailyChange: cells[3] || "",
      };
    })
    .filter(Boolean);
}

async function fetchNavPage(code, startDate, endDate, page, perPage) {
  const params = new URLSearchParams({
    type: "lsjz",
    code,
    page: String(page),
    per: String(perPage),
    sdate: startDate,
    edate: endDate,
  });
  const data = await loadProviderGlobal(`${NAV_URL}?${params.toString()}`, "apidata");
  return {
    rows: parseNavRows(data.content || ""),
    totalPages: Number(data.pages || 1),
  };
}

async function fetchNavRows(code, startDate, endDate) {
  const perPage = 49;
  const firstPage = await fetchNavPage(code, startDate, endDate, 1, perPage);
  const rows = [...firstPage.rows];
  const pageCount = Math.max(1, firstPage.totalPages);

  for (let page = 2; page <= pageCount; page += 1) {
    const pageData = await fetchNavPage(code, startDate, endDate, page, perPage);
    rows.push(...pageData.rows);
  }

  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

async function calculateAnnualized(code, buyDate, navType) {
  if (!/^\d{6}$/.test(code || "")) {
    throw new Error("基金代码应为 6 位数字。");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(buyDate || "")) {
    throw new Error("请选择买入日期。");
  }

  const today = todayText();
  if (parseDateDays(buyDate) >= parseDateDays(today)) {
    throw new Error("买入日期需要早于今天。");
  }

  const rows = await fetchNavRows(code, buyDate, today);
  if (rows.length < 2) {
    throw new Error("这个日期范围内净值数据不足，无法计算年化收益率。");
  }

  const valueKey = navType === "unit" ? "unitNav" : "accumulatedNav";
  const start = rows[0];
  const end = rows[rows.length - 1];
  const elapsedDays = parseDateDays(end.date) - parseDateDays(start.date);
  if (elapsedDays <= 0) {
    throw new Error("持有天数不足，无法计算年化收益率。");
  }

  const totalReturn = end[valueKey] / start[valueKey] - 1;
  const annualizedReturn = Math.pow(end[valueKey] / start[valueKey], 365 / elapsedDays) - 1;

  return {
    code,
    navType: valueKey === "unitNav" ? "unit" : "accumulated",
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

async function fetchFeeRules(code, amount, holdingDays) {
  const params = new URLSearchParams({
    code,
    amount: String(amount),
    holdingDays: String(holdingDays),
  });
  const response = await fetch(`/api/funds/fees?${params.toString()}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("费率接口尚未启用。需要通过 Git 导入 Netlify 部署后端函数。");
  }
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "费率查询失败。");
  }
  return data;
}

function calculateFee(rule, amount) {
  if (!rule) return 0;
  if (rule.type === "fixed") return Number(rule.value || 0);
  return amount - amount / (1 + Number(rule.value || 0));
}

function calculateRedemptionFee(rule, amount) {
  if (!rule) return 0;
  if (rule.type === "fixed") return Number(rule.value || 0);
  return amount * Number(rule.value || 0);
}

function formatRule(rule) {
  if (!rule) return "未匹配到费率规则";
  const feeText = rule.type === "fixed" ? `每笔${formatMoney(rule.value)}` : `${(rule.value * 100).toFixed(2)}%`;
  return `${rule.condition || "适用规则"} · ${feeText}`;
}

function setReturnClass(element, value) {
  element.className = value >= 0 ? "positive" : "negative";
}

function chooseFund(fund) {
  selectedFund.code = fund.code;
  selectedFund.name = fund.name;
  selectedFund.type = fund.type || "";
  selectedFund.company = fund.company || "";
  queryInput.value = `${fund.name}（${fund.code}）`;
  suggestions.innerHTML = "";
}

function renderSuggestions(funds) {
  suggestions.innerHTML = "";
  funds.forEach((fund, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `suggestion${index === 0 ? " is-selected" : ""}`;
    button.innerHTML = `
      <span>
        <strong>${fund.name}</strong>
        <small>${fund.type || "基金"} · ${fund.company || "基金公司"}</small>
      </span>
      <small>${fund.code}</small>
    `;
    button.addEventListener("click", () => chooseFund(fund));
    suggestions.appendChild(button);
  });

  if (funds.length === 1) {
    chooseFund(funds[0]);
  }
}

const searchFunds = debounce(async () => {
  const keyword = queryInput.value.trim().replace(/[（）()]/g, " ");
  selectedFund.code = /^\d{6}$/.test(keyword) ? keyword : "";
  selectedFund.name = "";

  if (keyword.length < 2) {
    suggestions.innerHTML = "";
    return;
  }

  try {
    renderSuggestions(await searchFundCatalog(keyword));
  } catch (error) {
    suggestions.innerHTML = `<div class="status-state error">${friendlyFetchError(error)}</div>`;
  }
});

queryInput.addEventListener("input", searchFunds);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fallbackCode = queryInput.value.match(/\d{6}/)?.[0] || "";
  const code = selectedFund.code || fallbackCode;
  const buyDate = buyDateInput.value;
  const navType = new FormData(form).get("nav-type");
  const purchaseAmount = Number(purchaseAmountInput.value);

  if (!code) {
    setState("error", "请先从搜索结果中选择一只基金，或直接输入 6 位基金代码。");
    return;
  }
  if (!Number.isFinite(purchaseAmount) || purchaseAmount <= 0) {
    setState("error", "请输入大于 0 的购买金额。");
    return;
  }

  setState("loading");
  try {
    renderResult(await calculateAnnualized(code, buyDate, navType), purchaseAmount);
  } catch (error) {
    setState("error", friendlyFetchError(error));
  }
});

async function renderResult(data, purchaseAmount) {
  const displayName = selectedFund.name || `基金 ${data.code}`;
  document.querySelector("#fund-name").textContent = `${displayName}（${data.code}）`;
  document.querySelector("#fund-meta").textContent =
    `${selectedFund.type || "公募基金"} · ${data.navType === "accumulated" ? "累计净值" : "单位净值"}口径`;

  const annualizedEl = document.querySelector("#annualized-return");
  const totalEl = document.querySelector("#total-return");
  annualizedEl.textContent = formatPercent(data.annualizedReturn);
  totalEl.textContent = formatPercent(data.totalReturn);
  setReturnClass(annualizedEl, data.annualizedReturn);
  setReturnClass(totalEl, data.totalReturn);

  document.querySelector("#holding-days").textContent = `${data.elapsedDays} 天`;
  document.querySelector("#start-date").textContent = data.startDate;
  document.querySelector("#start-nav").textContent = formatNav(data.startNav);
  document.querySelector("#end-date").textContent = data.endDate;
  document.querySelector("#end-nav").textContent = formatNav(data.endNav);

  await renderFeeResult(data, purchaseAmount);
  drawChart(data.series, data.navType);
  lastResult = data;
  setState("result");
}

async function renderFeeResult(data, purchaseAmount) {
  const afterFeeAnnualizedEl = document.querySelector("#after-fee-annualized-return");
  const afterFeeTotalEl = document.querySelector("#after-fee-total-return");
  const afterFeeValueEl = document.querySelector("#after-fee-value");
  const purchaseFeeEl = document.querySelector("#purchase-fee");
  const redemptionFeeEl = document.querySelector("#redemption-fee");
  const purchaseRuleEl = document.querySelector("#purchase-fee-rule");
  const redemptionRuleEl = document.querySelector("#redemption-fee-rule");
  const feeSourceEl = document.querySelector("#fee-source");

  try {
    const fees = await fetchFeeRules(data.code, purchaseAmount, data.elapsedDays);
    const purchaseFee = calculateFee(fees.purchaseRule, purchaseAmount);
    const investedAmount = Math.max(0, purchaseAmount - purchaseFee);
    const grossEndValue = investedAmount * (data.endNav / data.startNav);
    const redemptionFee = calculateRedemptionFee(fees.redemptionRule, grossEndValue);
    const afterFeeValue = Math.max(0, grossEndValue - redemptionFee);
    const afterFeeTotalReturn = afterFeeValue / purchaseAmount - 1;
    const afterFeeAnnualizedReturn =
      Math.pow(afterFeeValue / purchaseAmount, 365 / data.elapsedDays) - 1;

    afterFeeAnnualizedEl.textContent = formatPercent(afterFeeAnnualizedReturn);
    afterFeeTotalEl.textContent = formatPercent(afterFeeTotalReturn);
    afterFeeValueEl.textContent = formatMoney(afterFeeValue);
    purchaseFeeEl.textContent = formatMoney(purchaseFee);
    redemptionFeeEl.textContent = formatMoney(redemptionFee);
    purchaseRuleEl.textContent = formatRule(fees.purchaseRule);
    redemptionRuleEl.textContent = formatRule(fees.redemptionRule);
    feeSourceEl.textContent = "天天基金费率页";
    setReturnClass(afterFeeAnnualizedEl, afterFeeAnnualizedReturn);
    setReturnClass(afterFeeTotalEl, afterFeeTotalReturn);
  } catch (error) {
    afterFeeAnnualizedEl.textContent = "--";
    afterFeeTotalEl.textContent = "--";
    afterFeeValueEl.textContent = "--";
    purchaseFeeEl.textContent = "--";
    redemptionFeeEl.textContent = "--";
    purchaseRuleEl.textContent = friendlyFetchError(error);
    redemptionRuleEl.textContent = "费率接口不可用时无法估算当日赎回费。";
    feeSourceEl.textContent = "未获取到";
    afterFeeAnnualizedEl.className = "";
    afterFeeTotalEl.className = "";
  }
}

function drawChart(series, navType) {
  const ctx = chart.getContext("2d");
  const rect = chart.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  chart.width = Math.max(640, Math.floor(rect.width * ratio));
  chart.height = Math.floor(300 * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  const width = chart.width / ratio;
  const height = chart.height / ratio;
  const padding = { top: 18, right: 18, bottom: 34, left: 54 };
  const values = series.map((item) =>
    navType === "accumulated" ? item.accumulatedNav : item.unitNav
  );
  const isGain = values[values.length - 1] >= values[0];
  const chartColor = isGain ? "#c43d3d" : "#0f7b63";
  const chartFill = isGain ? "196, 61, 61" : "15, 123, 99";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#dce4df";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#64706b";
  ctx.font = "12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (innerHeight / 4) * i;
    const value = max - (span / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(value.toFixed(3), 8, y + 4);
  }

  ctx.beginPath();
  values.forEach((value, index) => {
    const x = padding.left + (innerWidth * index) / Math.max(1, values.length - 1);
    const y = padding.top + ((max - value) / span) * innerHeight;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = chartColor;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
  gradient.addColorStop(0, `rgba(${chartFill}, 0.18)`);
  gradient.addColorStop(1, `rgba(${chartFill}, 0)`);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  const first = series[0]?.date || "";
  const last = series[series.length - 1]?.date || "";
  ctx.fillStyle = "#64706b";
  ctx.fillText(first, padding.left, height - 10);
  const lastWidth = ctx.measureText(last).width;
  ctx.fillText(last, width - padding.right - lastWidth, height - 10);
}

window.addEventListener("resize", () => {
  if (!resultState.classList.contains("hidden") && lastResult) {
    drawChart(lastResult.series, lastResult.navType);
  }
});

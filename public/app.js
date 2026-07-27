const queryInput = document.querySelector("#fund-query");
const purchaseLots = document.querySelector("#purchase-lots");
const addLotButton = document.querySelector("#add-lot");
const suggestions = document.querySelector("#suggestions");
const form = document.querySelector("#calculator-form");
const emptyState = document.querySelector("#empty-state");
const loadingState = document.querySelector("#loading-state");
const errorState = document.querySelector("#error-state");
const resultState = document.querySelector("#result-state");
const chart = document.querySelector("#nav-chart");
const lotResults = document.querySelector("#lot-results");
let lastResult = null;
let fundCatalogPromise = null;
let providerScriptId = 0;
let lotId = 0;

const FUND_CATALOG_URL = "https://fund.eastmoney.com/js/fundcode_search.js";
const NAV_URL = "https://fundf10.eastmoney.com/F10DataApi.aspx";
const API_SEARCH_URL = "/api/funds/search";
const API_ANNUALIZED_URL = "/api/funds/returns";

const selectedFund = {
  code: "",
  name: "",
  type: "",
  company: "",
};

const maxBuyDate = new Date(Date.now() - 24 * 60 * 60 * 1000)
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

async function fetchJson(url, fallbackMessage) {
  const response = await fetch(url);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(fallbackMessage);
  }
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || fallbackMessage);
  }
  return data;
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
  const params = new URLSearchParams({ q: keyword });

  try {
    const data = await fetchJson(`${API_SEARCH_URL}?${params.toString()}`, "基金搜索接口暂时不可用。");
    if (Array.isArray(data.funds)) {
      return data.funds;
    }
  } catch (error) {
    console.warn("Fund search API failed, falling back to provider script.", error);
  }

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

function createLotRow(values = {}) {
  lotId += 1;
  const row = document.createElement("div");
  row.className = "lot-row";
  row.dataset.lotId = String(lotId);
  row.innerHTML = `
    <label class="field">
      <span>买入日期</span>
      <input class="lot-date" type="date" max="${maxBuyDate}" required />
    </label>
    <label class="field">
      <span>购买金额</span>
      <input
        class="lot-amount"
        type="number"
        min="1"
        step="0.01"
        placeholder="例如：10000"
        required
      />
    </label>
    <button class="icon-action remove-lot" type="button" aria-label="删除这笔买入">删除</button>
  `;

  row.querySelector(".lot-date").value = values.buyDate || "";
  row.querySelector(".lot-amount").value = values.amount || "";
  row.querySelector(".remove-lot").addEventListener("click", () => {
    if (purchaseLots.querySelectorAll(".lot-row").length <= 1) {
      row.querySelector(".lot-date").value = "";
      row.querySelector(".lot-amount").value = "";
      return;
    }
    row.remove();
    syncLotRemoveButtons();
  });
  purchaseLots.appendChild(row);
  syncLotRemoveButtons();
  return row;
}

function syncLotRemoveButtons() {
  const rows = [...purchaseLots.querySelectorAll(".lot-row")];
  rows.forEach((row) => {
    row.querySelector(".remove-lot").disabled = rows.length <= 1;
  });
}

function readPurchaseLots() {
  return [...purchaseLots.querySelectorAll(".lot-row")].map((row, index) => ({
    index: index + 1,
    buyDate: row.querySelector(".lot-date").value,
    amount: Number(row.querySelector(".lot-amount").value),
  }));
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

async function calculateAnnualizedDirect(code, buyDate, navType) {
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

async function calculateAnnualized(code, buyDate, navType) {
  const params = new URLSearchParams({
    code,
    buyDate,
    navType,
  });

  try {
    return await fetchJson(
      `${API_ANNUALIZED_URL}?${params.toString()}`,
      "净值计算接口暂时不可用。"
    );
  } catch (error) {
    console.warn("Annualized API failed, falling back to provider script.", error);
    return calculateAnnualizedDirect(code, buyDate, navType);
  }
}

async function fetchFeeRules(code, amount, holdingDays, buyDate) {
  const params = new URLSearchParams({
    code,
    amount: String(amount),
    holdingDays: String(holdingDays),
    buyDate,
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
  return `${rule.feeName ? `${rule.feeName} · ` : ""}${rule.condition || "适用规则"} · ${feeText}`;
}

function setReturnClass(element, value) {
  element.className = value >= 0 ? "positive" : "negative";
}

async function calculateLotResult(code, lot, navType) {
  const data = await calculateAnnualized(code, lot.buyDate, navType);
  let fees;
  try {
    fees = await fetchFeeRules(data.code, lot.amount, data.elapsedDays, data.requestedBuyDate);
  } catch (error) {
    throw new Error(`第 ${lot.index} 笔费率查询失败：${friendlyFetchError(error)}`);
  }

  const navRatio = data.endNav / data.startNav;
  const preFeeEndValue = lot.amount * navRatio;
  const purchaseFee = calculateFee(fees.purchaseRule, lot.amount);
  const investedAmount = Math.max(0, lot.amount - purchaseFee);
  const redemptionBase = investedAmount * navRatio;
  const redemptionFee = calculateRedemptionFee(fees.redemptionRule, redemptionBase);
  const afterFeeValue = Math.max(0, redemptionBase - redemptionFee);
  const afterFeeTotalReturn = afterFeeValue / lot.amount - 1;
  const afterFeeAnnualizedReturn =
    Math.pow(afterFeeValue / lot.amount, 365 / data.elapsedDays) - 1;

  return {
    ...data,
    lotIndex: lot.index,
    amount: lot.amount,
    preFeeEndValue,
    purchaseFee,
    redemptionFee,
    afterFeeValue,
    afterFeeTotalReturn,
    afterFeeAnnualizedReturn,
    purchaseRule: fees.purchaseRule,
    redemptionRule: fees.redemptionRule,
  };
}

function sumBy(items, getter) {
  return items.reduce((total, item) => total + getter(item), 0);
}

function weightedAverage(items, getter, weightGetter) {
  const totalWeight = sumBy(items, weightGetter);
  if (totalWeight <= 0) return 0;
  return sumBy(items, (item) => getter(item) * weightGetter(item)) / totalWeight;
}

function buildPortfolioResult(code, navType, lots) {
  const totalAmount = sumBy(lots, (lot) => lot.amount);
  const preFeeEndValue = sumBy(lots, (lot) => lot.preFeeEndValue);
  const afterFeeValue = sumBy(lots, (lot) => lot.afterFeeValue);
  const totalPurchaseFee = sumBy(lots, (lot) => lot.purchaseFee);
  const totalRedemptionFee = sumBy(lots, (lot) => lot.redemptionFee);
  const earliestLot = [...lots].sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  const latestLot = [...lots].sort((a, b) => b.endDate.localeCompare(a.endDate))[0];

  return {
    code,
    navType,
    lots,
    lotCount: lots.length,
    totalAmount,
    preFeeEndValue,
    afterFeeValue,
    totalPurchaseFee,
    totalRedemptionFee,
    totalReturn: preFeeEndValue / totalAmount - 1,
    annualizedReturn: weightedAverage(lots, (lot) => lot.annualizedReturn, (lot) => lot.amount),
    afterFeeTotalReturn: afterFeeValue / totalAmount - 1,
    afterFeeAnnualizedReturn: weightedAverage(
      lots,
      (lot) => lot.afterFeeAnnualizedReturn,
      (lot) => lot.amount
    ),
    weightedHoldingDays: weightedAverage(lots, (lot) => lot.elapsedDays, (lot) => lot.amount),
    startDate: earliestLot.startDate,
    startNav: earliestLot.startNav,
    endDate: latestLot.endDate,
    endNav: latestLot.endNav,
    series: earliestLot.series,
  };
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
addLotButton.addEventListener("click", () => {
  createLotRow();
});
createLotRow();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fallbackCode = queryInput.value.match(/\d{6}/)?.[0] || "";
  const code = selectedFund.code || fallbackCode;
  const navType = new FormData(form).get("nav-type");
  const lots = readPurchaseLots();

  if (!code) {
    setState("error", "请先从搜索结果中选择一只基金，或直接输入 6 位基金代码。");
    return;
  }

  for (const lot of lots) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lot.buyDate || "")) {
      setState("error", `请填写第 ${lot.index} 笔买入日期。`);
      return;
    }
    if (!Number.isFinite(lot.amount) || lot.amount <= 0) {
      setState("error", `请填写第 ${lot.index} 笔大于 0 的购买金额。`);
      return;
    }
  }

  setState("loading");
  try {
    const results = [];
    for (const lot of lots) {
      results.push(await calculateLotResult(code, lot, navType));
    }
    renderResult(buildPortfolioResult(code, navType, results));
  } catch (error) {
    setState("error", friendlyFetchError(error));
  }
});

function renderResult(data) {
  const displayName = selectedFund.name || `基金 ${data.code}`;
  document.querySelector("#fund-name").textContent = `${displayName}（${data.code}）`;
  document.querySelector("#fund-meta").textContent =
    `${selectedFund.type || "公募基金"} · ${data.navType === "accumulated" ? "累计净值" : "单位净值"}口径 · ${data.lotCount} 笔买入`;

  const annualizedEl = document.querySelector("#annualized-return");
  const totalEl = document.querySelector("#total-return");
  const afterFeeAnnualizedEl = document.querySelector("#after-fee-annualized-return");
  const afterFeeTotalEl = document.querySelector("#after-fee-total-return");
  annualizedEl.textContent = formatPercent(data.annualizedReturn);
  totalEl.textContent = formatPercent(data.totalReturn);
  afterFeeAnnualizedEl.textContent = formatPercent(data.afterFeeAnnualizedReturn);
  afterFeeTotalEl.textContent = formatPercent(data.afterFeeTotalReturn);
  setReturnClass(annualizedEl, data.annualizedReturn);
  setReturnClass(totalEl, data.totalReturn);
  setReturnClass(afterFeeAnnualizedEl, data.afterFeeAnnualizedReturn);
  setReturnClass(afterFeeTotalEl, data.afterFeeTotalReturn);

  document.querySelector("#holding-days").textContent = `${Math.round(data.weightedHoldingDays)} 天`;
  document.querySelector("#after-fee-value").textContent = formatMoney(data.afterFeeValue);
  document.querySelector("#start-date").textContent = data.startDate;
  document.querySelector("#start-nav").textContent = formatNav(data.startNav);
  document.querySelector("#end-date").textContent = data.endDate;
  document.querySelector("#end-nav").textContent = formatNav(data.endNav);

  document.querySelector("#purchase-fee").textContent = formatMoney(data.totalPurchaseFee);
  document.querySelector("#redemption-fee").textContent = formatMoney(data.totalRedemptionFee);
  document.querySelector("#purchase-fee-rule").textContent =
    `共 ${data.lotCount} 笔，按各笔买入日期匹配认购/申购费率。`;
  document.querySelector("#redemption-fee-rule").textContent =
    `按各笔持有天数匹配赎回费率。`;
  document.querySelector("#fee-source").textContent = "天天基金费率页";

  renderLotResults(data.lots);
  drawChart(data.series, data.navType);
  lastResult = data;
  setState("result");
}

function renderLotResults(lots) {
  lotResults.innerHTML = lots
    .map(
      (lot) => `
        <div class="lot-result">
          <div>
            <span>第 ${lot.lotIndex} 笔</span>
            <strong>${lot.requestedBuyDate}</strong>
          </div>
          <div>
            <span>金额</span>
            <strong>${formatMoney(lot.amount)}</strong>
          </div>
          <div>
            <span>确认净值日</span>
            <strong>${lot.startDate}</strong>
          </div>
          <div>
            <span>费后年化</span>
            <strong class="${lot.afterFeeAnnualizedReturn >= 0 ? "positive" : "negative"}">${formatPercent(lot.afterFeeAnnualizedReturn)}</strong>
          </div>
          <div>
            <span>买入费</span>
            <strong>${formatMoney(lot.purchaseFee)}</strong>
            <small>${formatRule(lot.purchaseRule)}</small>
          </div>
          <div>
            <span>赎回费</span>
            <strong>${formatMoney(lot.redemptionFee)}</strong>
            <small>${formatRule(lot.redemptionRule)}</small>
          </div>
        </div>
      `
    )
    .join("");
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
  const chartColor = isGain ? "#c43d3d" : "#008c74";
  const chartFill = isGain ? "196, 61, 61" : "0, 140, 116";
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

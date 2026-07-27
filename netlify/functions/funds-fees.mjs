const FEE_PAGE_BASE = "https://fundf10.eastmoney.com/jjfl_";
const BASIC_PAGE_BASE = "https://fundf10.eastmoney.com/jbgk_";

function jsonResponse(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      referer: "https://fundf10.eastmoney.com/",
    },
  });
  if (!response.ok) {
    throw new Error(`天天基金费率页响应异常：${response.status}`);
  }
  return response.text();
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlToLines(html) {
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<\/?(tr|p|div|h\d|li|table|tbody|thead|dl|dt|dd|br)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
  return text
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function section(lines, startTexts, endTexts) {
  const starts = Array.isArray(startTexts) ? startTexts : [startTexts];
  const start = lines.findIndex((line) => starts.some((text) => line.includes(text)));
  if (start < 0) return [];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (endTexts.some((text) => lines[index].includes(text))) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function parseMoney(text) {
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return text.includes("万元") ? value * 10000 : value;
}

function parseDays(text) {
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  if (text.includes("年")) return value * 365;
  if (text.includes("月")) return value * 30;
  return value;
}

function parseDateDays(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function normalizeChineseDate(text) {
  const match = String(text || "").match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function parseAmountCondition(condition) {
  const rule = { min: 0, max: Infinity };
  const compact = condition.replace(/[,，\s]/g, "");
  const moneyValue = (match) => {
    if (!match) return null;
    const valueText = match.find((part, index) => index > 0 && /^\d/.test(part || ""));
    if (!valueText) return null;
    const value = Number(valueText);
    const unit = match.find((part) => /万|元/.test(part || "")) || "";
    return unit.includes("万") ? value * 10000 : value;
  };
  const lower =
    compact.match(/(大于等于|不少于|不低于|满|达到)(\d+(?:\.\d+)?)(万元|万|元)?/) ||
    compact.match(/(\d+(?:\.\d+)?)(万元|万|元)?(以上|及以上)/);
  const upper =
    compact.match(/(小于|低于|少于|不足|小于等于|不超过|不高于)(\d+(?:\.\d+)?)(万元|万|元)?/) ||
    compact.match(/(\d+(?:\.\d+)?)(万元|万|元)?(以下|以内)/);
  const lowerValue = moneyValue(lower);
  const upperValue = moneyValue(upper);
  if (lowerValue !== null) rule.min = lowerValue;
  if (upperValue !== null) rule.max = upperValue;
  return rule;
}

function parseDayCondition(condition) {
  const rule = { min: 0, max: Infinity };
  const compact = condition.replace(/[,，\s]/g, "");
  const dayValue = (match) => {
    if (!match) return null;
    const valueText = match.find((part, index) => index > 0 && /^\d/.test(part || ""));
    if (!valueText) return null;
    const unit = match.find((part) => /天|日|月|年/.test(part || "")) || "天";
    const value = `${valueText}${unit}`;
    return parseDays(value);
  };
  const lower =
    compact.match(/(大于等于|不少于|不低于|满|达到)(\d+(?:\.\d+)?)(天|日|个月|月|年)?/) ||
    compact.match(/(\d+(?:\.\d+)?)(天|日|个月|月|年)?(以上|及以上)/);
  const upperStrict =
    compact.match(/(小于|低于|少于|不足)(\d+(?:\.\d+)?)(天|日|个月|月|年)?/);
  const upperInclusive =
    compact.match(/(小于等于|不超过|不高于)(\d+(?:\.\d+)?)(天|日|个月|月|年)?/) ||
    compact.match(/(\d+(?:\.\d+)?)(天|日|个月|月|年)?(以内|以下)/);
  const lowerValue = dayValue(lower);
  const upperStrictValue = dayValue(upperStrict);
  const upperInclusiveValue = dayValue(upperInclusive);
  if (lowerValue !== null) rule.min = lowerValue;
  if (upperStrictValue !== null) rule.max = upperStrictValue;
  if (upperInclusiveValue !== null) rule.max = upperInclusiveValue + 0.000001;
  return rule;
}

function parseRuleLine(line, conditionParser) {
  if (/友情提示|基金申购费用计算公式|基金赎回费用计算公式/.test(line)) return null;
  if (!/(---|小于|大于等于|不少于|不低于|每笔|\d+(?:\.\d+)?%|不收取|免收)/.test(line)) return null;
  const fixed = line.match(/每笔\s*(\d+(?:\.\d+)?)\s*元/);
  const percentages = [...line.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
  const free = !fixed && percentages.length === 0 && /(不收取|免收)/.test(line);
  if (!fixed && percentages.length === 0 && !free) return null;

  const conditionEnd = fixed ? fixed.index : free ? line.search(/不收取|免收/) : percentages[0].index;
  const condition = (line.slice(0, conditionEnd).replace(/[|~]/g, "").trim() || (free ? "未披露收费档位" : ""));
  if (!condition) return null;

  return {
    condition,
    ...conditionParser(condition),
    type: fixed ? "fixed" : "rate",
    value: fixed ? Number(fixed[1]) : free ? 0 : Number(percentages[percentages.length - 1][1]) / 100,
    raw: line,
  };
}

function parseRules(lines, conditionParser) {
  return lines
    .map((line) => parseRuleLine(line, conditionParser))
    .filter(Boolean);
}

function findAmountRule(rules, amount) {
  return (
    rules.find((rule) => amount >= rule.min && amount < rule.max) ||
    rules[rules.length - 1] ||
    null
  );
}

function findDayRule(rules, holdingDays) {
  return (
    rules.find((rule) => holdingDays >= rule.min && holdingDays < rule.max) ||
    rules[rules.length - 1] ||
    null
  );
}

function zeroFeeRule(feeName, condition) {
  return {
    condition,
    min: 0,
    max: Infinity,
    type: "rate",
    value: 0,
    feeName,
    raw: condition,
    estimated: true,
  };
}

function parseFeeRulesFromHtml(html) {
  const lines = htmlToLines(html);
  const subscriptionRules = parseRules(
    section(lines, "认购费率", ["申购费率", "赎回费率", "友情提示"]),
    parseAmountCondition
  );
  const purchaseRules = parseRules(
    section(lines, ["申购费率（前端）", "申购费率"], ["申购费率（后端）", "赎回费率", "友情提示"]),
    parseAmountCondition
  );
  const redemptionRules = parseRules(
    section(lines, "赎回费率", ["友情提示", "注：", "基金申购费用计算公式", "本基金费率来源"]),
    parseDayCondition
  );
  return { subscriptionRules, purchaseRules, redemptionRules };
}

function parseFundDatesFromHtml(html) {
  const text = htmlToLines(html).join(" ");
  const issueMatch = text.match(/发行日期\s*(\d{4}年\s*\d{1,2}月\s*\d{1,2}日)/);
  const establishmentMatch =
    text.match(/成立日期\/规模\s*(\d{4}年\s*\d{1,2}月\s*\d{1,2}日)/) ||
    text.match(/成立日期[:：]\s*(\d{4}-\d{2}-\d{2})/);
  return {
    issueDate: normalizeChineseDate(issueMatch?.[1]),
    establishmentDate: establishmentMatch?.[1]?.includes("年")
      ? normalizeChineseDate(establishmentMatch[1])
      : establishmentMatch?.[1] || null,
  };
}

function determinePurchaseKind(buyDate, fundDates) {
  const buyDay = parseDateDays(buyDate);
  const issueDay = parseDateDays(fundDates.issueDate);
  const establishmentDay = parseDateDays(fundDates.establishmentDate);
  if (buyDay !== null && issueDay !== null && establishmentDay !== null) {
    if (buyDay >= issueDay && buyDay < establishmentDay) {
      return "subscription";
    }
  }
  return "purchase";
}

export default async (request) => {
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").trim();
  const amount = Number(url.searchParams.get("amount") || "0");
  const holdingDays = Number(url.searchParams.get("holdingDays") || "0");
  const buyDate = (url.searchParams.get("buyDate") || "").trim();

  if (!/^\d{6}$/.test(code)) {
    return errorResponse("基金代码应为 6 位数字");
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return errorResponse("购买金额需要大于 0");
  }
  if (!Number.isFinite(holdingDays) || holdingDays <= 0) {
    return errorResponse("持有天数不足，无法匹配赎回费率");
  }
  if (buyDate && parseDateDays(buyDate) === null) {
    return errorResponse("买入日期格式应为 YYYY-MM-DD");
  }

  try {
    const sourceUrl = `${FEE_PAGE_BASE}${code}.html`;
    const basicUrl = `${BASIC_PAGE_BASE}${code}.html`;
    const [feeHtml, basicHtml] = await Promise.all([fetchText(sourceUrl), fetchText(basicUrl)]);
    const { subscriptionRules, purchaseRules, redemptionRules } = parseFeeRulesFromHtml(feeHtml);
    const fundDates = parseFundDatesFromHtml(basicHtml);
    const purchaseKind = determinePurchaseKind(buyDate, fundDates);
    const activePurchaseRules = purchaseKind === "subscription" ? subscriptionRules : purchaseRules;
    const purchaseFeeName = purchaseKind === "subscription" ? "认购费率" : "申购费率";

    const feeWarnings = [];
    let purchaseRule = findAmountRule(activePurchaseRules, amount);
    let redemptionRule = findDayRule(redemptionRules, holdingDays);

    if (!purchaseRule) {
      purchaseRule = zeroFeeRule(purchaseFeeName, `未披露${purchaseFeeName}，按 0 估算`);
      feeWarnings.push(purchaseRule.condition);
    }
    if (!redemptionRule) {
      redemptionRule = zeroFeeRule("赎回费率", "未披露赎回费率，按 0 估算");
      feeWarnings.push(redemptionRule.condition);
    }

    if (!purchaseRule) {
      return errorResponse(`购买金额没有匹配到${purchaseFeeName}档位，请核对金额后重试`, 502);
    }
    if (!redemptionRule) {
      return errorResponse("持有天数没有匹配到赎回费率档位，请核对日期后重试", 502);
    }

    return jsonResponse({
      code,
      amount,
      holdingDays,
      buyDate,
      sourceUrl,
      basicUrl,
      fundDates,
      purchaseKind,
      purchaseFeeName,
      purchaseRule: { ...purchaseRule, feeName: purchaseFeeName },
      redemptionRule,
      feeWarnings,
      subscriptionRules,
      purchaseRules,
      redemptionRules,
    });
  } catch (error) {
    return errorResponse(`费率查询失败：${error.message}`, 502);
  }
};

export const config = {
  path: "/api/funds/fees",
  method: "GET",
};

export const __test__ = {
  parseFeeRulesFromHtml,
  parseFundDatesFromHtml,
  determinePurchaseKind,
  findAmountRule,
  findDayRule,
};

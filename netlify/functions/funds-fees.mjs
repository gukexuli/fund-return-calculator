const FEE_PAGE_BASE = "https://fundf10.eastmoney.com/jjfl_";

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

function section(lines, startText, endTexts) {
  const start = lines.findIndex((line) => line.includes(startText));
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

function parseAmountCondition(condition) {
  const rule = { min: 0, max: Infinity };
  const lower = condition.match(/大于等于\s*(\d+(?:\.\d+)?)\s*万元?/);
  const upper = condition.match(/小于\s*(\d+(?:\.\d+)?)\s*万元?/);
  const lowerYuan = condition.match(/大于等于\s*(\d+(?:\.\d+)?)\s*元/);
  const upperYuan = condition.match(/小于\s*(\d+(?:\.\d+)?)\s*元/);
  if (lower) rule.min = Number(lower[1]) * 10000;
  if (upper) rule.max = Number(upper[1]) * 10000;
  if (lowerYuan) rule.min = Number(lowerYuan[1]);
  if (upperYuan) rule.max = Number(upperYuan[1]);
  return rule;
}

function parseDayCondition(condition) {
  const rule = { min: 0, max: Infinity };
  const lower = condition.match(/大于等于\s*(\d+(?:\.\d+)?)\s*(天|月|年)/);
  const upper = condition.match(/小于\s*(\d+(?:\.\d+)?)\s*(天|月|年)/);
  if (lower) rule.min = parseDays(lower[0]);
  if (upper) rule.max = parseDays(upper[0]);
  return rule;
}

function parseRuleLine(line, conditionParser) {
  if (!/(小于|大于等于|每笔|\d+(?:\.\d+)?%)/.test(line)) return null;
  const fixed = line.match(/每笔\s*(\d+(?:\.\d+)?)\s*元/);
  const percentages = [...line.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
  if (!fixed && percentages.length === 0) return null;

  const conditionEnd = fixed ? fixed.index : percentages[0].index;
  const condition = line.slice(0, conditionEnd).replace(/[|~]/g, "").trim();
  if (!condition) return null;

  return {
    condition,
    ...conditionParser(condition),
    type: fixed ? "fixed" : "rate",
    value: fixed ? Number(fixed[1]) : Number(percentages[percentages.length - 1][1]) / 100,
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

export default async (request) => {
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").trim();
  const amount = Number(url.searchParams.get("amount") || "0");
  const holdingDays = Number(url.searchParams.get("holdingDays") || "0");

  if (!/^\d{6}$/.test(code)) {
    return errorResponse("基金代码应为 6 位数字");
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return errorResponse("购买金额需要大于 0");
  }
  if (!Number.isFinite(holdingDays) || holdingDays <= 0) {
    return errorResponse("持有天数不足，无法匹配赎回费率");
  }

  try {
    const sourceUrl = `${FEE_PAGE_BASE}${code}.html`;
    const lines = htmlToLines(await fetchText(sourceUrl));
    const purchaseRules = parseRules(
      section(lines, "申购费率（前端）", ["申购费率（后端）", "赎回费率", "友情提示"]),
      parseAmountCondition
    );
    const redemptionRules = parseRules(
      section(lines, "赎回费率", ["注：", "基金申购费用计算公式", "本基金费率来源"]),
      parseDayCondition
    );

    const purchaseRule = findAmountRule(purchaseRules, amount) || {
      condition: "未披露前端申购费率，按 0 估算",
      min: 0,
      max: Infinity,
      type: "rate",
      value: 0,
      raw: "",
    };
    const redemptionRule = findDayRule(redemptionRules, holdingDays) || {
      condition: "未披露赎回费率，按 0 估算",
      min: 0,
      max: Infinity,
      type: "rate",
      value: 0,
      raw: "",
    };

    return jsonResponse({
      code,
      amount,
      holdingDays,
      sourceUrl,
      purchaseRule,
      redemptionRule,
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

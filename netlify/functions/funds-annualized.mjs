import { calculateAnnualized, errorResponse, jsonResponse } from "./fund-utils.mjs";

export default async (request) => {
  const url = new URL(request.url);
  try {
    const result = await calculateAnnualized(
      (url.searchParams.get("code") || "").trim(),
      (url.searchParams.get("buyDate") || "").trim(),
      (url.searchParams.get("navType") || "accumulated").trim()
    );
    return jsonResponse(result);
  } catch (error) {
    const isInputError = /基金代码|日期|净值数据不足|持有天数/.test(error.message);
    return errorResponse(error.message, isInputError ? 400 : 502);
  }
};

export const config = {
  path: "/api/funds/annualized",
  method: "GET",
};

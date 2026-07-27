import { errorResponse, jsonResponse, searchFunds } from "./fund-utils.mjs";

export default async (request) => {
  const url = new URL(request.url);
  const keyword = (url.searchParams.get("q") || "").trim();
  if (!keyword) {
    return jsonResponse({ funds: [] });
  }

  try {
    return jsonResponse({ funds: await searchFunds(keyword) });
  } catch (error) {
    return errorResponse(`基金搜索失败：${error.message}`, 502);
  }
};

export const config = {
  path: "/api/funds/search",
  method: "GET",
};

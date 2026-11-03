#!/usr/bin/env node
/**
 * 抓取今日油价（92# / 95# / 98#）→ public/oil-price.json
 *
 * - 构建前自动执行（见 package.json 的 build 脚本），也可手动 `pnpm oil` 刷新
 * - 上游接口不可用时保留原有文件，退出码 0，不影响构建
 *
 * 环境变量（可写进 .env，CI 里用 Secrets）：
 *   OIL_PRICE_PROVINCE  省份 / 直辖市。默认读 src/lib/constants.ts 的 OIL_PRICE.province
 *   APIZERO_KEY          apizero 的 API Key（匿名额度只有 5 次/天，登录后 20 次/天，建议配置）
 *   APIHZ_ID / APIHZ_KEY 接口盒的公共 ID 与 KEY（apizero 挂了时的备用价格源）
 *   OIL_PRICE_MIN_REFRESH_MINUTES  最短刷新间隔（分钟）。上游是「每个接口每天 20 次」，
 *                                   24 次/天会超额度，所以默认按 ~90 分钟刷一次（16 次/天）
 *   OIL_PRICE_FORCE=1              忽略上面的间隔，强制抓一次
 *   OIL_PRICE_STRICT=1             抓不到上游时以退出码 1 失败（定时刷新任务用，
 *                                   避免「任务全绿但数据一直是旧的」）
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(resolve(ROOT, ".env"));
} catch {
  /* 没有 .env 就直接用环境变量 */
}

/** 省份统一从 src/lib/constants.ts 的 OIL_PRICE.province 读，改那一处即可 */
function provinceFromConstants() {
  try {
    const src = readFileSync(resolve(ROOT, "src/lib/constants.ts"), "utf8");
    const matched = /province:\s*["'`]([^"'`]+)["'`]/s.exec(src);
    return matched?.[1] ?? "";
  } catch {
    return "";
  }
}

const OUT_FILE = resolve(ROOT, "public/oil-price.json");
const PROVINCE =
  process.env.OIL_PRICE_PROVINCE || provinceFromConstants() || "江苏";
const APIZERO_KEY = process.env.APIZERO_KEY || "";
const APIHZ_ID = process.env.APIHZ_ID || "";
const APIHZ_KEY = process.env.APIHZ_KEY || "";
const MIN_REFRESH_MINUTES = Number(
  process.env.OIL_PRICE_MIN_REFRESH_MINUTES || 80,
);
const FORCE = process.env.OIL_PRICE_FORCE === "1";
const STRICT = process.env.OIL_PRICE_STRICT === "1";

const PRICE_API = "https://v1.apizero.cn/api/oil-price";
const FORECAST_API =
  "https://v1.apizero.cn/api/oil-price-forecast?action=forecast";
const APIHZ_API = "https://cn.apihz.cn/api/jinrong/youjia.php";

const TIMEOUT = 8000;

async function getJson(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 主数据源：apizero（实时油价 + 调价预测） */
async function fetchApiZero() {
  const headers = { "Content-Type": "application/json" };
  if (APIZERO_KEY) headers.Authorization = `Bearer ${APIZERO_KEY}`;

  const [priceBody, forecastBody] = await Promise.all([
    getJson(PRICE_API, {
      method: "POST",
      headers,
      body: JSON.stringify({ province: PROVINCE }),
    }),
    getJson(FORECAST_API, {
      headers: APIZERO_KEY ? { Authorization: `Bearer ${APIZERO_KEY}` } : {},
    }),
  ]);

  return {
    price: priceBody?.code === 0 ? priceBody.data : null,
    forecast: forecastBody?.code === 0 ? forecastBody.data : null,
  };
}

/** 备用价格源：接口盒（只有价格，没有预测） */
async function fetchApiHz() {
  if (!APIHZ_ID || !APIHZ_KEY) return null;

  const url =
    `${APIHZ_API}?id=${encodeURIComponent(APIHZ_ID)}` +
    `&key=${encodeURIComponent(APIHZ_KEY)}` +
    `&sheng=${encodeURIComponent(PROVINCE)}`;
  const body = await getJson(url);
  if (body?.code !== 200 || !body?.data) return null;

  const zone = body.data.data1 ?? {};
  const prices = [];
  const push = (name, type, value) => {
    if (value === null || value === undefined) return;
    prices.push({ name, type, price: Number(value), unit: "元/升" });
  };

  push("92号汽油", "gasoline_92", zone["92"]);
  push("95号汽油", "gasoline_95", zone["95"]);
  // 部分省份不供应 98#，用「爱跑 98」顶替
  push("98号汽油", "gasoline_98", zone["98"] ?? zone["ap98"]);
  push("0号柴油", "diesel_0", zone["0h"]);
  if (!prices.length) return null;

  return {
    province: body.sheng || PROVINCE,
    update_date: String(body.date ?? "").replace(/年|月/g, "-").replace(/日$/, ""),
    prices,
    next_adjustment: "",
    forecast: "",
  };
}

/** 读取已有的数据文件（上游全挂时用来兜底，也是判断刷新间隔的依据） */
function readExisting() {
  try {
    if (!existsSync(OUT_FILE)) return null;
    return JSON.parse(readFileSync(OUT_FILE, "utf8"));
  } catch {
    return null;
  }
}

const existing = readExisting();

// 上游是「每个接口每天 20 次」，抓太勤会直接 429，所以先看看手上的数据够不够新
const ageMinutes = existing?.fetchedAt
  ? (Date.now() - existing.fetchedAt) / 60000
  : Infinity;
if (!FORCE && ageMinutes < MIN_REFRESH_MINUTES) {
  console.log(
    `[oil-price] 数据是 ${Math.round(ageMinutes)} 分钟前抓的（阈值 ${MIN_REFRESH_MINUTES} 分钟），本次跳过`,
  );
  process.exit(0);
}

const { price, forecast } = await fetchApiZero();
const finalPrice = price ?? (await fetchApiHz());

if (!finalPrice) {
  // 价格接口挂了、预测接口还活着：价格留着旧的，只把预测刷新掉
  if (existing?.price && forecast) {
    if (STRICT) {
      console.error(
        "[oil-price] 严格模式：价格接口不可用（只拿到调价预测），本次刷新判定为失败",
      );
      process.exit(1);
    }
    existing.forecast = forecast;
    existing.fetchedAt = Date.now();
    writeFileSync(OUT_FILE, JSON.stringify(existing, null, 2), "utf8");
    console.log("[oil-price] 价格接口不可用，只更新了调价预测");
    process.exit(0);
  }

  console.warn(
    "[oil-price] 上游接口暂时不可用，保留 public/oil-price.json 里的旧数据",
  );
  if (STRICT) {
    console.error("[oil-price] 严格模式：上游接口不可用，本次刷新判定为失败");
    process.exit(1);
  }
  process.exit(0);
}

const payload = {
  province: finalPrice.province || PROVINCE,
  fetchedAt: Date.now(),
  price: finalPrice,
  forecast,
};

writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");

const summary = finalPrice.prices
  .filter((p) => p.type.startsWith("gasoline"))
  .map((p) => `${p.type.replace("gasoline_", "")}# ${p.price}`)
  .join("  ");
const trend = forecast?.prediction
  ? `${forecast.prediction.direction} ${forecast.prediction.estimated_change_per_ton} 元/吨`
  : "预测暂缺";
console.log(`[oil-price] ${payload.province} ${summary}  |  ${trend}`);
console.log(
  `[oil-price] 数据日期 ${finalPrice.update_date || "-"}，写入时间 ${new Date(
    payload.fetchedAt,
  ).toLocaleString("zh-CN")}`,
);

if (!APIZERO_KEY) {
  console.warn(
    "[oil-price] 提示：匿名额度 5 次/天，登录后 20 次/天（apizero.cn/account/keys）",
  );
}

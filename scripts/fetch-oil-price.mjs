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
 *   OIL_PRICE_MIN_REFRESH_MINUTES  最短刷新间隔（分钟）。上游匿名额度是「每个接口每天 5 次」，
 *                                   默认 360 分钟（约 4 次/天）留出安全余量；
 *                                   定时刷新是每天一次，24 小时 > 360 分钟，不受影响
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
  process.env.OIL_PRICE_MIN_REFRESH_MINUTES || 360,
);
const FORCE = process.env.OIL_PRICE_FORCE === "1";
const STRICT = process.env.OIL_PRICE_STRICT === "1";

const PRICE_API = "https://v1.apizero.cn/api/oil-price";
const FORECAST_API =
  "https://v1.apizero.cn/api/oil-price-forecast?action=forecast";
const APIHZ_API = "https://cn.apihz.cn/api/jinrong/youjia.php";

const TIMEOUT = 8000;

/**
 * 调价发生后的「等上游缓存刷新」窗口。
 * 调价通常在 24 时生效，上游价格接口的缓存切换有延迟，
 * 这段时间内需要缩短刷新间隔，才能尽快拿到调价后的新价格。
 */
const ADJUST_WAIT_WINDOW_MS = 48 * 60 * 60 * 1000;

/** 处于等上游刷新的窗口内时，用更短的刷新间隔 */
const ADJUST_WAIT_REFRESH_MINUTES = Number(
  process.env.OIL_PRICE_ADJUST_WAIT_MINUTES || 60,
);

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

/**
 * 从「下次油价11月26日24时调整」这类文案里解析出调价时刻（当天 24 时，即次日 0 点）。
 * 调价发生后，新价格必须到下一个调价日才生效，所以这个时刻是判断
 * 「当前油价」是否已经切换到新一轮的关键。
 */
function parseAdjustmentMoment(text) {
  const matched = /(\d{1,2})月(\d{1,2})日/.exec(text ?? "");
  if (!matched) return null;
  const month = Number(matched[1]);
  const day = Number(matched[2]);
  // 「11月26日24时」= 11 月 27 日 0 点，按本地时区构造
  const moment = new Date(new Date().getFullYear(), month - 1, day, 0, 0, 0, 0);
  moment.setDate(moment.getDate() + 1);
  return moment;
}

/**
 * 判断上游返回的「当前油价」是不是调价前的旧快照。
 *
 * 上游价格接口带缓存层：调价生效后的一段时间内，它仍会返回上一轮的旧价格，
 * 但 next_adjustment 文案已经指向下一个调价日、预测接口也已经按新一轮计算。
 * 此时如果照单全收，页面就会一直显示调价前的价格。
 *
 * 判定依据：next_adjustment 指向的时刻已经过去（说明这份价格数据跨过了调价点，
 * 却还是旧价），或者它与预测接口给出的下一轮调价日不一致。
 */
function isStaleSnapshot(price, forecast, now = new Date()) {
  if (!price) return false;

  const moment = parseAdjustmentMoment(price.next_adjustment);
  if (moment && moment.getTime() <= now.getTime()) {
    return true; // 调价时刻已过，价格却还是调价前的
  }

  // 预测接口给出的下一轮调价日，比价格接口自报的更晚 → 价格接口落后了一轮
  const nextFromForecast = forecast?.next_adjust_date;
  if (moment && nextFromForecast) {
    const forecastMoment = new Date(`${nextFromForecast}T00:00:00`);
    if (!Number.isNaN(forecastMoment.getTime()) && forecastMoment.getTime() > moment.getTime()) {
      return true;
    }
  }

  return false;
}

/**
 * 调价发生后的一段时间内，上游缓存可能还没切换过来。
 * 这段时间里要更频繁地重试，否则「当前油价」会停留在上一轮。
 */
function isAdjustWindowOpen(price, now = new Date()) {
  if (!price) return false;
  const moment = parseAdjustmentMoment(price.next_adjustment);
  if (!moment) return false;
  // 调价时刻已过，但新一轮价格还没生效 → 处于「等上游刷新」的窗口
  const elapsed = now.getTime() - moment.getTime();
  return elapsed > 0 && elapsed < ADJUST_WAIT_WINDOW_MS;
}

const existing = readExisting();

// 上游是「每个接口每天 20 次」，抓太勤会直接 429，所以先看看手上的数据够不够新
const ageMinutes = existing?.fetchedAt
  ? (Date.now() - existing.fetchedAt) / 60000
  : Infinity;

// 调价刚发生、上游缓存还没切过来时，用更短的间隔重试，
// 否则「当前油价」会整轮停留在调价前的价格上
const waitingForNewPrice = isAdjustWindowOpen(existing?.price);
const refreshMinutes = waitingForNewPrice
  ? Math.min(MIN_REFRESH_MINUTES, ADJUST_WAIT_REFRESH_MINUTES)
  : MIN_REFRESH_MINUTES;

if (!FORCE && ageMinutes < refreshMinutes) {
  console.log(
    `[oil-price] 数据是 ${Math.round(ageMinutes)} 分钟前抓的（阈值 ${refreshMinutes} 分钟），本次跳过`,
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

// 上游价格接口有缓存层：调价后它可能仍返回调价前的旧价格。
// 这种数据不能当作「当前油价」写进去，否则页面会一直显示上一轮的价格。
const stale = isStaleSnapshot(finalPrice, forecast);

if (stale) {
  console.warn(
    "[oil-price] 上游返回的仍是调价前的旧价格（缓存尚未刷新），本次不覆盖已有的当前油价",
  );

  // 已有数据同样陈旧时也没有更新的价值，保留原样并按失败处理
  if (!existing?.price || isStaleSnapshot(existing.price, existing.forecast)) {
    if (STRICT) {
      console.error(
        "[oil-price] 严格模式：上游价格快照已陈旧且本地无有效数据，本次刷新判定为失败",
      );
      process.exit(1);
    }
    console.warn("[oil-price] 本地也没有更新一轮的价格，保持现有数据不变");
    process.exit(0);
  }

  // 本地有有效价格：只刷新预测部分，当前油价保持不动
  existing.forecast = forecast;
  existing.fetchedAt = Date.now();
  writeFileSync(OUT_FILE, JSON.stringify(existing, null, 2), "utf8");
  console.log("[oil-price] 保留已有的当前油价，只更新了调价预测");
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

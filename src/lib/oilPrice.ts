/**
 * 今日油价（92# / 95# / 98# 汽油）
 *
 * 数据链路：
 *   构建期 scripts/fetch-oil-price.mjs 抓上游 → public/oil-price.json
 *   浏览器读同源 /oil-price.json（不消耗上游配额，也没有跨域问题）
 *
 * 上游接口：
 *   - 实时油价 POST https://v1.apizero.cn/api/oil-price     各省发改委零售限价
 *   - 调价预测 GET  https://v1.apizero.cn/api/oil-price-forecast?action=forecast
 *     依据国际原油实时行情测算「截至当前」的累计变化与涨跌方向
 *
 * 吨价 → 升价：按各标号汽油密度换算（1 吨 ≈ 升数），与发改委调价表口径一致。
 */

export const OIL_GRADES = ["92", "95", "98"] as const;

export type OilGrade = (typeof OIL_GRADES)[number];

/** 每吨汽油约合多少升（92# 密度 0.7344、95# 0.7410、98# 0.7435 g/cm³） */
const LITERS_PER_TON: Record<OilGrade, number> = {
  "92": 1361.7,
  "95": 1349.5,
  "98": 1344.9,
};

export interface RawPricePayload {
  province: string;
  /** 上游有时返回 null（缓存快照里没有这个字段），此时用抓取时间兜底 */
  update_date: string | null;
  prices: { name: string; type: string; price: number; unit: string }[];
  next_adjustment: string;
  forecast: string;
  /** 本轮计价周期截至当前的累计变化（元/吨），官方口径 */
  estimated_change_per_ton?: number;
  /** 计价周期第几个工作日 */
  working_day?: number;
  /** 国际原油均价变化率（%） */
  change_rate?: number;
  change_rate_as_of?: string;
  crude_avg_usd?: number;
}

export interface RawForecastPayload {
  next_adjust_date: string;
  days_remaining: number;
  prediction: {
    direction: string;
    estimated_change_per_ton: number;
    estimated_change_per_liter: number;
    confidence: string;
    analysis: string;
  };
}

/** public/oil-price.json 的结构 */
export interface RawOilFile {
  province: string;
  fetchedAt: number;
  price: RawPricePayload | null;
  forecast: RawForecastPayload | null;
}

export interface OilGradePrice {
  grade: OilGrade;
  /** 当前零售价（元/升） */
  price: number;
  /** 截至当前的预计调整幅度（元/升），正数为上调 */
  change: number | null;
  /** 预计调价后的价格（元/升） */
  expected: number | null;
}

export interface OilSnapshot {
  province: string;
  /** 油价数据更新日期 YYYY-MM-DD */
  updateDate: string;
  /** 下次调价生效日期 YYYY-MM-DD */
  nextAdjustDate: string;
  /** 距调价生效剩余天数 */
  daysRemaining: number;
  /** 调价方向：上涨 / 下跌 / 搁浅 / 待定 */
  direction: string;
  /** 本轮累计变化（元/吨） */
  changePerTon: number | null;
  grades: OilGradePrice[];
  /** 数据抓取时间戳 */
  fetchedAt: number;
  /**
   * 当前价格是否还停留在调价前。
   * 上游价格接口有缓存层，调价生效后的一段时间内仍返回上一轮的旧价格；
   * 这时「当前油价」不能当作新价展示，涨跌推算也要一并停用。
   */
  stale: boolean;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** 从「下次油价10月29日24时调整」这类文案里抠出日期 */
function parseAdjustDate(text: string): string {
  const matched = /(\d{1,2})月(\d{1,2})日/.exec(text ?? "");
  if (!matched) return "";
  const year = new Date().getFullYear();
  const month = String(matched[1]).padStart(2, "0");
  const day = String(matched[2]).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 解析「下次油价11月26日24时调整」里的调价时刻。
 * 「24时」= 当天结束，也就是次日 0 点。
 */
function parseAdjustMoment(text: string): Date | null {
  const matched = /(\d{1,2})月(\d{1,2})日/.exec(text ?? "");
  if (!matched) return null;
  const year = new Date().getFullYear();
  const moment = new Date(year, Number(matched[1]) - 1, Number(matched[2]));
  moment.setDate(moment.getDate() + 1);
  return moment;
}

/**
 * 判断上游给的「当前油价」是不是调价前的旧快照。
 *
 * 上游价格接口带缓存层：调价生效后的一段时间内，它仍会返回上一轮的旧价格，
 * 但 next_adjustment 文案已经指向下一个调价日。此时如果照单全收，
 * 页面就会一直显示调价前的价格 —— 正是线上出现过的现象。
 *
 * 判定依据：next_adjustment 指向的时刻已经过去（调价点已跨过，价格却还是旧的），
 * 或者它比预测接口给出的下一轮调价日更早（价格接口落后了一轮）。
 */
export function isStalePrice(
  price: RawPricePayload | null,
  forecast: RawForecastPayload | null,
  now: Date = new Date(),
): boolean {
  if (!price) return false;

  const moment = parseAdjustMoment(price.next_adjustment);
  if (moment && moment.getTime() <= now.getTime()) return true;

  const nextFromForecast = forecast?.next_adjust_date;
  if (moment && nextFromForecast) {
    const forecastMoment = new Date(`${nextFromForecast}T00:00:00`);
    if (
      !Number.isNaN(forecastMoment.getTime()) &&
      forecastMoment.getTime() > moment.getTime()
    ) {
      return true;
    }
  }

  return false;
}

function daysUntil(iso: string): number {
  if (!iso) return 0;
  const target = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(target.getTime())) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** 兜底用抓取时间当「更新日期」，格式与上游的 YYYY-MM-DD 保持一致 */
function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 把上游原始数据整理成卡片需要的结构 */
export function normalizeOilData(
  raw: RawOilFile | null,
  fallbackProvince = "",
): OilSnapshot | null {
  if (!raw?.price) return null;

  const priceData = raw.price;
  const prediction = raw.forecast?.prediction;

  // 上游缓存里可能还留着调价前的价格，这时不能把它当作「当前油价」
  const stale = isStalePrice(priceData, raw.forecast);

  // 两个来源，优先用官方口径：
  // 1) 价格接口里的 estimated_change_per_ton —— 本轮计价周期「截至当前」的累计变化
  //    （配套字段 working_day / change_rate，和发改委调价周期一个口径）
  // 2) 预测接口的 estimated_change_per_ton —— 按国际原油实时走势对整轮的预测
  const officialPerTon =
    typeof priceData.estimated_change_per_ton === "number"
      ? priceData.estimated_change_per_ton
      : null;
  const predictedPerTon =
    typeof prediction?.estimated_change_per_ton === "number"
      ? prediction.estimated_change_per_ton
      : null;

  let changePerTon: number | null = null;
  let direction = "待定";

  if (officialPerTon !== null) {
    changePerTon = officialPerTon;
    direction =
      officialPerTon > 0 ? "上涨" : officialPerTon < 0 ? "下跌" : "搁浅";
  } else if (predictedPerTon !== null) {
    const dir = prediction?.direction ?? "待定";
    const want = dir === "上涨" ? 1 : dir === "下跌" ? -1 : 0;
    // 预测接口偶尔正负号和描述对不上，以方向为准
    changePerTon =
      want === 0
        ? 0
        : Math.sign(predictedPerTon) === want
          ? predictedPerTon
          : -predictedPerTon;
    direction = dir;
  }

  const grades = OIL_GRADES.map((grade) => {
    const item = priceData.prices?.find((p) => p.type === `gasoline_${grade}`);
    const price = item ? Number(item.price) : NaN;
    const hasPrice = !Number.isNaN(price);
    // 价格还停在调价前时，用它推算「调价后价格」没有意义
    const change =
      stale || changePerTon === null || !hasPrice
        ? null
        : changePerTon / LITERS_PER_TON[grade];

    return {
      grade,
      price: hasPrice ? price : NaN,
      change,
      expected: change === null ? null : round2(price + change),
    };
  });

  const nextAdjustDate =
    raw.forecast?.next_adjust_date || parseAdjustDate(priceData.next_adjustment);
  const daysRemaining =
    typeof raw.forecast?.days_remaining === "number"
      ? raw.forecast.days_remaining
      : daysUntil(nextAdjustDate);

  return {
    province: priceData.province || raw.province || fallbackProvince,
    // 上游缓存快照里这个字段可能是 null，兜底用抓取时间，至少能显示「哪天抓的」
    updateDate:
      priceData.update_date ||
      formatIsoDate(new Date(raw.fetchedAt ?? Date.now())),
    // 兜底解析出来的日期如果已经过去，说明那条文案是旧的，就别显示了
    nextAdjustDate: daysUntil(nextAdjustDate) < 0 ? "" : nextAdjustDate,
    daysRemaining,
    direction,
    changePerTon,
    grades,
    fetchedAt: raw.fetchedAt ?? Date.now(),
    stale,
  };
}

/** 读取同源的 oil-price.json 并整理 */
export async function loadOilFile(
  url: string,
  fallbackProvince = "",
): Promise<OilSnapshot | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const raw = (await res.json()) as RawOilFile;
    return normalizeOilData(raw, fallbackProvince);
  } catch {
    return null;
  }
}

export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toFixed(2);
}

/** 预计调整幅度，如 ↓0.58 / ↑0.31 */
export function formatChange(change: number | null | undefined): string {
  if (change === null || change === undefined || Number.isNaN(change)) return "—";
  if (Math.abs(change) < 0.005) return "±0.00";
  return `${change > 0 ? "↑" : "↓"}${Math.abs(change).toFixed(2)}`;
}

/** 2026-10-29 → 10月29日 */
export function formatAdjustDate(iso: string): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!matched) return iso || "—";
  return `${Number(matched[2])}月${Number(matched[3])}日`;
}

/** 距调价生效的倒计时文案 */
export function formatCountdown(days: number): string {
  if (days <= 0) return "今晚";
  if (days === 1) return "明天";
  return `${days}天后`;
}

/** 涨跌配色：涨红跌绿 */
export function changeClass(change: number | null | undefined): string {
  if (change === null || change === undefined || Number.isNaN(change))
    return "text-gray-500";
  if (change > 0) return "text-red-400";
  if (change < 0) return "text-green-400";
  return "text-gray-400";
}

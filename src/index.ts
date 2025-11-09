import { existsSync } from "fs";
import { resolve } from "path";

import { config as loadEnv } from "dotenv";

loadEnv();

if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) {
  const rootEnvPath = resolve(__dirname, "../../../.env");
  if (existsSync(rootEnvPath)) {
    loadEnv({ path: rootEnvPath, override: false });
  }
}

function mask(value?: string, visible: number = 4) {
  if (!value) return "missing";
  if (value.length <= visible) return "*".repeat(value.length);
  const suffix = value.slice(-visible);
  return `${"*".repeat(value.length - visible)}${suffix}`;
}

const hasApiKey = Boolean(process.env.BYBIT_API_KEY);
const hasApiSecret = Boolean(process.env.BYBIT_API_SECRET);

if (!hasApiKey || !hasApiSecret) {
  console.error(
    `[env] Missing Bybit credentials. apiKey=${mask(process.env.BYBIT_API_KEY)} secret=${mask(
      process.env.BYBIT_API_SECRET
    )}`
  );
} else {
  console.log(
    `[env] Loaded Bybit credentials. apiKey=${mask(process.env.BYBIT_API_KEY)} secret=${mask(
      process.env.BYBIT_API_SECRET
    )}`
  );
}

import type { BybitFundingTicker } from "../lib/bybit-top-funding";
import { fetchFundingTicker, fetchTopFundingTickers } from "../lib/bybit-top-funding";
import {
  getFundingHistory,
  getOrderExecutions,
  getPositionSize,
  getWalletBalance,
  placeLimitOrder,
  TradeSide,
} from "../lib/bybit-trading";

const POLL_INTERVAL_MS = 1000;
const MONITOR_INTERVAL_MS = 60_000;
const PRE_FUNDING_MS = 5_000;
const POST_FUNDING_MS = 5_000;
const FUNDING_THRESHOLD = 0.005; // 0.5%
const TRADE_NOTIONAL_USD = 500;
const MAX_CLOSE_ATTEMPTS = 5;
const MAX_DRAWDOWN_PCT = 0.03; // 3%
const ACCOUNT_COIN = process.env.BYBIT_ACCOUNT_COIN ?? "USDT";

interface ScheduledTrade {
  fundingTime: number;
  openTimer?: NodeJS.Timeout;
}

interface ActivePosition {
  symbol: string;
  side: TradeSide;
  qty: number;
  entryPrice: number;
  fundingTime: number;
  openedAt: number;
  entryOrderLinkId: string;
  closeOrderLinkIds: string[];
  closeTimer?: NodeJS.Timeout;
}

interface ExecutionSummary {
  fee: number;
  tradePnl: number;
}

let pollHandle: NodeJS.Timer | undefined;
let monitorHandle: NodeJS.Timer | undefined;
const schedules = new Map<string, ScheduledTrade>();
const activePositions = new Map<string, ActivePosition>();
const latestTickers = new Map<string, BybitFundingTicker>();
const openingSymbols = new Set<string>();
let tradingEnabled = true;
let startingEquity: number | null = null;
let drawdownLimitUsd = 0;

function parseFundingTimestamp(value?: string): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return value.length === 10 ? numeric * 1000 : numeric;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatFundingRate(rate: number) {
  return `${(rate * 100).toFixed(2)}%`;
}

function minutesUntil(timestampMs: number): number {
  return Math.max(0, Math.round((timestampMs - Date.now()) / 60_000));
}

function logHighFundingTickers() {
  if (!tradingEnabled) return;

  const highFunding = Array.from(latestTickers.values())
    .filter((ticker) => Math.abs(ticker.fundingRate ?? 0) >= FUNDING_THRESHOLD)
    .sort((a, b) => (Math.abs(b.fundingRate ?? 0) - Math.abs(a.fundingRate ?? 0)));

  if (highFunding.length === 0) {
    console.log(`[${nowIso()}] No tickers above funding threshold (${formatFundingRate(FUNDING_THRESHOLD)}).`);
    return;
  }

  const formatted = highFunding
    .map((ticker) => {
      const rate = ticker.fundingRate ?? 0;
      const fundingTimestamp = parseFundingTimestamp(ticker.nextFundingTime ?? undefined);
      const eta =
        fundingTimestamp !== null
          ? `${minutesUntil(fundingTimestamp)}m`
          : "n/a";
      return `  • ${ticker.symbol} ${formatFundingRate(rate)} · funding in ${eta}`;
    })
    .join("\n");

  console.log(`[${nowIso()}] High funding tickers (${highFunding.length}):\n${formatted}`);
}

async function summarizeExecutions(orderLinkIds: string[]): Promise<ExecutionSummary> {
  const unique = Array.from(new Set(orderLinkIds.filter(Boolean)));
  if (unique.length === 0) {
    return { fee: 0, tradePnl: 0 };
  }

  const summaries = await Promise.all(
    unique.map(async (id) => {
      try {
        const executions = await getOrderExecutions(id);
        const fee = executions
          .map((exec: any) => Number(exec.execFee ?? 0))
          .filter((value: number) => Number.isFinite(value))
          .reduce((sum: number, value: number) => sum + value, 0);
        const tradePnl = executions
          .map((exec: any) => (exec.execType === "Trade" ? Number(exec.execPnl ?? 0) : 0))
          .filter((value: number) => Number.isFinite(value))
          .reduce((sum: number, value: number) => sum + value, 0);
        return { fee: Math.abs(fee), tradePnl };
      } catch (error) {
        console.error(`[${nowIso()}] Failed to summarize executions for ${id}:`, error);
        return { fee: 0, tradePnl: 0 };
      }
    })
  );

  return summaries.reduce(
    (acc, summary) => ({
      fee: acc.fee + summary.fee,
      tradePnl: acc.tradePnl + summary.tradePnl,
    }),
    { fee: 0, tradePnl: 0 }
  );
}

async function fetchFundingFee(symbol: string, startTime: number, endTime: number): Promise<number> {
  try {
    const history = await getFundingHistory(symbol, startTime - 12 * 60 * 60 * 1000, endTime + 12 * 60 * 60 * 1000);
    return history
      .map((entry: any) => {
        const execTime = Number(entry.execTime ?? entry.timestamp ?? Date.now());
        const feeValue = Number(entry.fundingFee ?? entry.funding ?? 0);
        if (!Number.isFinite(execTime) || !Number.isFinite(feeValue)) return 0;
        if (execTime < startTime || execTime > endTime + 5 * 60 * 1000) return 0;
        return feeValue;
      })
      .reduce((sum: number, value: number) => sum + value, 0);
  } catch (error) {
    console.error(`[${nowIso()}] Failed to fetch funding history for ${symbol}:`, error);
    return 0;
  }
}

function clearSchedule(symbol: string) {
  const entry = schedules.get(symbol);
  if (entry?.openTimer) {
    clearTimeout(entry.openTimer);
  }
  schedules.delete(symbol);
}

function clearActivePosition(symbol: string) {
  const position = activePositions.get(symbol);
  if (position?.closeTimer) {
    clearTimeout(position.closeTimer);
  }
  activePositions.delete(symbol);
}

async function finalizePosition(symbol: string) {
  const position = activePositions.get(symbol);
  if (!position) return;

  try {
    const entrySummary = await summarizeExecutions([position.entryOrderLinkId]);
    const closeSummary = await summarizeExecutions(position.closeOrderLinkIds);
    const grossPnl = entrySummary.tradePnl + closeSummary.tradePnl;
    const totalFees = entrySummary.fee + closeSummary.fee;
    const fundingFee = await fetchFundingFee(symbol, position.openedAt - 30 * 60 * 1000, Date.now());

    let currentEquity: number | null = null;
    let equityChange: number | null = null;
    let drawdown: number | null = null;

    try {
      const balance = await getWalletBalance(ACCOUNT_COIN);
      currentEquity = balance.totalEquity;
      if (startingEquity !== null) {
        equityChange = currentEquity - startingEquity;
        drawdown = startingEquity - currentEquity;
      }
      const equityDisplay = currentEquity !== null ? formatUsd(currentEquity) : "n/a";
      const changeDisplay = equityChange !== null ? ` · Change ${formatUsd(equityChange)}` : "";
      const drawdownDisplay =
        drawdown !== null ? ` · Drawdown ${formatUsd(drawdown)} (limit ${formatUsd(drawdownLimitUsd)})` : "";

      console.log(
        `[${nowIso()}] ${symbol} closed · Gross ${formatUsd(grossPnl)} · Fees ${formatUsd(
          -totalFees
        )} · Funding ${formatUsd(fundingFee)} · Equity ${equityDisplay}${changeDisplay}${drawdownDisplay}`
      );
    } catch (error) {
      console.error(`[${nowIso()}] Failed to refresh wallet balance after closing ${symbol}:`, error);
    }

    if (startingEquity !== null && currentEquity !== null && drawdown !== null) {
      if (drawdown >= drawdownLimitUsd && tradingEnabled) {
        console.error(
          `[${nowIso()}] Max drawdown reached. Starting equity ${formatUsd(
            startingEquity
          )} · Current equity ${formatUsd(currentEquity)} · Drawdown ${formatUsd(drawdown)} (limit ${formatUsd(
            drawdownLimitUsd
          )}). Halting strategy.`
        );
        tradingEnabled = false;
        await shutdown();
      }
    }
  } catch (error) {
    console.error(`[${nowIso()}] Failed to finalize position for ${symbol}:`, error);
  } finally {
    clearActivePosition(symbol);
  }
}

async function closePosition(symbol: string) {
  const position = activePositions.get(symbol);
  if (!position) return;

  const closeSide: TradeSide = position.side === "Buy" ? "Sell" : "Buy";

  for (let attempt = 1; attempt <= MAX_CLOSE_ATTEMPTS; attempt++) {
    let currentSize = 0;
    try {
      currentSize = await getPositionSize(symbol);
    } catch (error) {
      console.error(`[${nowIso()}] Failed to read position size for ${symbol}:`, error);
      await sleep(500);
      continue;
    }

    if (currentSize <= 0) {
      break;
    }

    const ticker = latestTickers.get(symbol);
    const referencePrice = ticker
      ? closeSide === "Buy"
        ? ticker.askPrice ?? ticker.markPrice ?? ticker.lastPrice
        : ticker.bidPrice ?? ticker.markPrice ?? ticker.lastPrice
      : position.entryPrice;

    if (!referencePrice || referencePrice <= 0) {
      console.error(`[${nowIso()}] Missing price reference to close ${symbol}.`);
      break;
    }

    try {
      const result = await placeLimitOrder({
        symbol,
        side: closeSide,
        price: referencePrice,
        qty: currentSize,
        reduceOnly: true,
      });
      console.log(
        `[${nowIso()}] Close attempt ${attempt}/${MAX_CLOSE_ATTEMPTS} for ${symbol} sent @ ${referencePrice} (qty ${currentSize}).`
      );
      if (result.orderLinkId) {
        position.closeOrderLinkIds.push(result.orderLinkId);
      }
    } catch (error) {
      console.error(`[${nowIso()}] Close attempt ${attempt} for ${symbol} failed:`, error);
    }

    await sleep(1_000);
  }

  await finalizePosition(symbol);
}

async function openPosition(symbol: string, fundingTime: number) {
  if (!tradingEnabled) return;
  if (openingSymbols.has(symbol) || activePositions.has(symbol)) return;

  openingSymbols.add(symbol);
  try {
    let ticker = latestTickers.get(symbol);
    try {
      const refreshed = await fetchFundingTicker(symbol);
      if (refreshed) {
        ticker = refreshed;
        latestTickers.set(symbol, refreshed);
      }
    } catch (error) {
      console.error(`[${nowIso()}] Failed to refresh ticker for ${symbol}:`, error);
    }

    if (!ticker) {
      console.warn(`[${nowIso()}] Missing ticker snapshot for ${symbol}, skipping open.`);
      return;
    }

    const fundingRate = ticker.fundingRate ?? 0;
    if (Math.abs(fundingRate) < FUNDING_THRESHOLD) {
      console.warn(`[${nowIso()}] ${symbol} funding ${fundingRate} below threshold, skipping.`);
      return;
    }

    const side: TradeSide = fundingRate >= 0 ? "Sell" : "Buy";
    const referencePrice = ticker.markPrice ?? ticker.lastPrice ?? ticker.bidPrice ?? ticker.askPrice;

    if (!referencePrice || referencePrice <= 0) {
      console.error(`[${nowIso()}] Missing reference price for ${symbol}, cannot open.`);
      return;
    }

    const rawQty = TRADE_NOTIONAL_USD / referencePrice;

    try {
      const result = await placeLimitOrder({
        symbol,
        side,
        price: referencePrice,
        qty: rawQty,
        reduceOnly: false,
      });

      const entryPrice = Number(result.price ?? referencePrice);
      const qty = Number(result.qty ?? rawQty);

      const closeDelay = Math.max(fundingTime + POST_FUNDING_MS - Date.now(), 500);
      const closeTimer = setTimeout(() => {
        void closePosition(symbol);
      }, closeDelay);

      activePositions.set(symbol, {
        symbol,
        side,
        qty,
        entryPrice,
        fundingTime,
        openedAt: Date.now(),
        entryOrderLinkId: result.orderLinkId,
        closeOrderLinkIds: [],
        closeTimer,
      });

      console.log(
        `[${nowIso()}] Opened ${symbol} ${side} @ ${entryPrice} (qty ${qty}) · close scheduled in ${Math.round(
          closeDelay / 1000
        )}s.`
      );
    } catch (error) {
      console.error(`[${nowIso()}] Failed to open ${symbol}:`, error);
    }
  } finally {
    openingSymbols.delete(symbol);
  }
}

function scheduleTrade(ticker: BybitFundingTicker) {
  const fundingTime = parseFundingTimestamp(ticker.nextFundingTime);
  if (!fundingTime) return;
  if (fundingTime <= Date.now()) return;

  if (Math.abs(ticker.fundingRate ?? 0) < FUNDING_THRESHOLD) {
    return;
  }

  const existing = schedules.get(ticker.symbol);
  if (existing?.fundingTime === fundingTime) return;

  const openTime = fundingTime - PRE_FUNDING_MS;
  const now = Date.now();
  const timeUntilOpen = openTime - now;

  if (existing) {
    clearSchedule(ticker.symbol);
  }

  if (timeUntilOpen > PRE_FUNDING_MS) {
    return;
  }

  if (timeUntilOpen <= 0) {
    console.log(
      `[${nowIso()}] Funding window reached for ${ticker.symbol}; attempting immediate open (funding @ ${new Date(
        fundingTime
      ).toISOString()}).`
    );
    void openPosition(ticker.symbol, fundingTime);
    return;
  }

  console.log(
    `[${nowIso()}] Scheduling ${ticker.symbol} for funding @ ${new Date(fundingTime).toISOString()} (open in ${Math.round(
      timeUntilOpen / 1000
    )}s).`
  );

  const openTimer = setTimeout(() => {
    schedules.delete(ticker.symbol);
    void openPosition(ticker.symbol, fundingTime);
  }, timeUntilOpen);

  schedules.set(ticker.symbol, { fundingTime, openTimer });
}

async function pollTickers() {
  if (!tradingEnabled) return;

  try {
    const tickers = await fetchTopFundingTickers(50);
    tickers.forEach((ticker) => {
      latestTickers.set(ticker.symbol, ticker);
    });

    const sorted = tickers
      .filter((ticker) => ticker.nextFundingTime)
      .sort((a, b) => {
        const rateDiff = (b.fundingRateAbs ?? 0) - (a.fundingRateAbs ?? 0);
        if (rateDiff !== 0) return rateDiff;
        const aTime = parseFundingTimestamp(a.nextFundingTime) ?? Infinity;
        const bTime = parseFundingTimestamp(b.nextFundingTime) ?? Infinity;
        return aTime - bTime;
      })
      .slice(0, 10);

    const activeSymbols = new Set(sorted.map((ticker) => ticker.symbol));

    sorted.forEach((ticker) => scheduleTrade(ticker));

    for (const symbol of schedules.keys()) {
      if (!activeSymbols.has(symbol)) {
        console.log(`[${nowIso()}] Unscheduling ${symbol} (no longer in top selection).`);
        clearSchedule(symbol);
      }
    }
  } catch (error) {
    console.error(`[${nowIso()}] Failed to poll tickers:`, error);
  }
}

async function shutdown() {
  if (pollHandle) {
    clearInterval(pollHandle as unknown as NodeJS.Timeout);
    pollHandle = undefined;
  }
  if (monitorHandle) {
    clearInterval(monitorHandle as unknown as NodeJS.Timeout);
    monitorHandle = undefined;
  }

  for (const symbol of schedules.keys()) {
    clearSchedule(symbol);
  }

  for (const symbol of activePositions.keys()) {
    await closePosition(symbol).catch((error) => {
      console.error(`[${nowIso()}] Error while closing ${symbol} during shutdown:`, error);
    });
  }

  console.log(`[${nowIso()}] Strategy halted.`);
}

async function main() {
  console.log(`[${nowIso()}] Starting Bybit funding strategy bot.`);

  try {
    const balance = await getWalletBalance(ACCOUNT_COIN);
    startingEquity = balance.totalEquity;
    drawdownLimitUsd = startingEquity * MAX_DRAWDOWN_PCT;
    const drawdownPct = (MAX_DRAWDOWN_PCT * 100).toFixed(1);

    console.log(
      `[risk] Portfolio snapshot (${balance.coin}) · Total equity ${formatUsd(startingEquity)} · Available ${formatUsd(
        balance.availableBalance
      )} · Max drawdown ${formatUsd(drawdownLimitUsd)} (${drawdownPct}%)`
    );
  } catch (error) {
    console.error(`[risk] Failed to load wallet balance for ${ACCOUNT_COIN}:`, error);
    throw error;
  }

  pollHandle = setInterval(() => {
    void pollTickers();
  }, POLL_INTERVAL_MS);
  monitorHandle = setInterval(() => {
    logHighFundingTickers();
  }, MONITOR_INTERVAL_MS);

  await pollTickers();
  logHighFundingTickers();
}

process.on("SIGINT", async () => {
  console.log("\n[signal] Caught SIGINT. Exiting...");
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[signal] Caught SIGTERM. Exiting...");
  await shutdown();
  process.exit(0);
});

void main().catch((error) => {
  console.error(`[${nowIso()}] Fatal error starting bot:`, error);
  process.exit(1);
});

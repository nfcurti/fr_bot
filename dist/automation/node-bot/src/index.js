"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
const dotenv_1 = require("dotenv");
(0, dotenv_1.config)();
if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) {
    const rootEnvPath = (0, path_1.resolve)(__dirname, "../../../.env");
    if ((0, fs_1.existsSync)(rootEnvPath)) {
        (0, dotenv_1.config)({ path: rootEnvPath, override: false });
    }
}
function mask(value, visible = 4) {
    if (!value)
        return "missing";
    if (value.length <= visible)
        return "*".repeat(value.length);
    const suffix = value.slice(-visible);
    return `${"*".repeat(value.length - visible)}${suffix}`;
}
const hasApiKey = Boolean(process.env.BYBIT_API_KEY);
const hasApiSecret = Boolean(process.env.BYBIT_API_SECRET);
if (!hasApiKey || !hasApiSecret) {
    console.error(`[env] Missing Bybit credentials. apiKey=${mask(process.env.BYBIT_API_KEY)} secret=${mask(process.env.BYBIT_API_SECRET)}`);
}
else {
    console.log(`[env] Loaded Bybit credentials. apiKey=${mask(process.env.BYBIT_API_KEY)} secret=${mask(process.env.BYBIT_API_SECRET)}`);
}
const bybit_top_funding_1 = require("../../../lib/bybit-top-funding");
const bybit_trading_1 = require("../../../lib/bybit-trading");
const POLL_INTERVAL_MS = 1000;
const MONITOR_INTERVAL_MS = 60000;
const PRE_FUNDING_MS = 5000;
const POST_FUNDING_MS = 5000;
const FUNDING_THRESHOLD = 0.005; // 0.5%
const TRADE_NOTIONAL_USD = 500;
const MAX_CLOSE_ATTEMPTS = 5;
const DAILY_STOP_LOSS = -(TRADE_NOTIONAL_USD * 0.1); // -10%
let pollHandle;
let monitorHandle;
const schedules = new Map();
const activePositions = new Map();
const latestTickers = new Map();
const openingSymbols = new Set();
let dailyPnl = 0;
let tradingEnabled = true;
function parseFundingTimestamp(value) {
    if (!value)
        return null;
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
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function formatUsd(value) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
}
function formatFundingRate(rate) {
    return `${(rate * 100).toFixed(2)}%`;
}
function minutesUntil(timestampMs) {
    return Math.max(0, Math.round((timestampMs - Date.now()) / 60000));
}
function logHighFundingTickers() {
    if (!tradingEnabled)
        return;
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
        const eta = fundingTimestamp !== null
            ? `${minutesUntil(fundingTimestamp)}m`
            : "n/a";
        return `  • ${ticker.symbol} ${formatFundingRate(rate)} · funding in ${eta}`;
    })
        .join("\n");
    console.log(`[${nowIso()}] High funding tickers (${highFunding.length}):\n${formatted}`);
}
async function summarizeExecutions(orderLinkIds) {
    const unique = Array.from(new Set(orderLinkIds.filter(Boolean)));
    if (unique.length === 0) {
        return { fee: 0, tradePnl: 0 };
    }
    const summaries = await Promise.all(unique.map(async (id) => {
        try {
            const executions = await (0, bybit_trading_1.getOrderExecutions)(id);
            const fee = executions
                .map((exec) => Number(exec.execFee ?? 0))
                .filter((value) => Number.isFinite(value))
                .reduce((sum, value) => sum + value, 0);
            const tradePnl = executions
                .map((exec) => (exec.execType === "Trade" ? Number(exec.execPnl ?? 0) : 0))
                .filter((value) => Number.isFinite(value))
                .reduce((sum, value) => sum + value, 0);
            return { fee: Math.abs(fee), tradePnl };
        }
        catch (error) {
            console.error(`[${nowIso()}] Failed to summarize executions for ${id}:`, error);
            return { fee: 0, tradePnl: 0 };
        }
    }));
    return summaries.reduce((acc, summary) => ({
        fee: acc.fee + summary.fee,
        tradePnl: acc.tradePnl + summary.tradePnl,
    }), { fee: 0, tradePnl: 0 });
}
async function fetchFundingFee(symbol, startTime, endTime) {
    try {
        const history = await (0, bybit_trading_1.getFundingHistory)(symbol, startTime - 12 * 60 * 60 * 1000, endTime + 12 * 60 * 60 * 1000);
        return history
            .map((entry) => {
            const execTime = Number(entry.execTime ?? entry.timestamp ?? Date.now());
            const feeValue = Number(entry.fundingFee ?? entry.funding ?? 0);
            if (!Number.isFinite(execTime) || !Number.isFinite(feeValue))
                return 0;
            if (execTime < startTime || execTime > endTime + 5 * 60 * 1000)
                return 0;
            return feeValue;
        })
            .reduce((sum, value) => sum + value, 0);
    }
    catch (error) {
        console.error(`[${nowIso()}] Failed to fetch funding history for ${symbol}:`, error);
        return 0;
    }
}
function clearSchedule(symbol) {
    const entry = schedules.get(symbol);
    if (entry?.openTimer) {
        clearTimeout(entry.openTimer);
    }
    schedules.delete(symbol);
}
function clearActivePosition(symbol) {
    const position = activePositions.get(symbol);
    if (position?.closeTimer) {
        clearTimeout(position.closeTimer);
    }
    activePositions.delete(symbol);
}
async function finalizePosition(symbol) {
    const position = activePositions.get(symbol);
    if (!position)
        return;
    try {
        const entrySummary = await summarizeExecutions([position.entryOrderLinkId]);
        const closeSummary = await summarizeExecutions(position.closeOrderLinkIds);
        const grossPnl = entrySummary.tradePnl + closeSummary.tradePnl;
        const totalFees = entrySummary.fee + closeSummary.fee;
        const fundingFee = await fetchFundingFee(symbol, position.openedAt - 30 * 60 * 1000, Date.now());
        const netPnl = grossPnl - totalFees - fundingFee;
        dailyPnl += netPnl;
        console.log(`[${nowIso()}] ${symbol} closed · Gross ${formatUsd(grossPnl)} · Fees ${formatUsd(-totalFees)} · Funding ${formatUsd(fundingFee)} · Net ${formatUsd(netPnl)} · 24h PnL ${formatUsd(dailyPnl)}`);
        if (dailyPnl <= DAILY_STOP_LOSS && tradingEnabled) {
            console.error(`[${nowIso()}] Daily PnL ${formatUsd(dailyPnl)} breached stop-loss ${formatUsd(DAILY_STOP_LOSS)}. Halting strategy.`);
            tradingEnabled = false;
            await shutdown();
        }
    }
    catch (error) {
        console.error(`[${nowIso()}] Failed to finalize position for ${symbol}:`, error);
    }
    finally {
        clearActivePosition(symbol);
    }
}
async function closePosition(symbol) {
    const position = activePositions.get(symbol);
    if (!position)
        return;
    const closeSide = position.side === "Buy" ? "Sell" : "Buy";
    for (let attempt = 1; attempt <= MAX_CLOSE_ATTEMPTS; attempt++) {
        let currentSize = 0;
        try {
            currentSize = await (0, bybit_trading_1.getPositionSize)(symbol);
        }
        catch (error) {
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
            const result = await (0, bybit_trading_1.placeLimitOrder)({
                symbol,
                side: closeSide,
                price: referencePrice,
                qty: currentSize,
                reduceOnly: true,
            });
            console.log(`[${nowIso()}] Close attempt ${attempt}/${MAX_CLOSE_ATTEMPTS} for ${symbol} sent @ ${referencePrice} (qty ${currentSize}).`);
            if (result.orderLinkId) {
                position.closeOrderLinkIds.push(result.orderLinkId);
            }
        }
        catch (error) {
            console.error(`[${nowIso()}] Close attempt ${attempt} for ${symbol} failed:`, error);
        }
        await sleep(1000);
    }
    await finalizePosition(symbol);
}
async function openPosition(symbol, fundingTime) {
    if (!tradingEnabled)
        return;
    if (openingSymbols.has(symbol) || activePositions.has(symbol))
        return;
    openingSymbols.add(symbol);
    let ticker = latestTickers.get(symbol);
    try {
        const refreshed = await (0, bybit_top_funding_1.fetchFundingTicker)(symbol);
        if (refreshed) {
            ticker = refreshed;
            latestTickers.set(symbol, refreshed);
        }
    }
    catch (error) {
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
    const side = fundingRate >= 0 ? "Sell" : "Buy";
    const referencePrice = ticker.markPrice ?? ticker.lastPrice ?? ticker.bidPrice ?? ticker.askPrice;
    if (!referencePrice || referencePrice <= 0) {
        console.error(`[${nowIso()}] Missing reference price for ${symbol}, cannot open.`);
        return;
    }
    const rawQty = TRADE_NOTIONAL_USD / referencePrice;
    try {
        const result = await (0, bybit_trading_1.placeLimitOrder)({
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
        console.log(`[${nowIso()}] Opened ${symbol} ${side} @ ${entryPrice} (qty ${qty}) · close scheduled in ${Math.round(closeDelay / 1000)}s.`);
    }
    catch (error) {
        console.error(`[${nowIso()}] Failed to open ${symbol}:`, error);
    }
    finally {
        openingSymbols.delete(symbol);
    }
}
function scheduleTrade(ticker) {
    const fundingTime = parseFundingTimestamp(ticker.nextFundingTime);
    if (!fundingTime)
        return;
    if (fundingTime <= Date.now())
        return;
    if (Math.abs(ticker.fundingRate ?? 0) < FUNDING_THRESHOLD) {
        return;
    }
    const existing = schedules.get(ticker.symbol);
    if (existing?.fundingTime === fundingTime)
        return;
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
        console.log(`[${nowIso()}] Funding window reached for ${ticker.symbol}; attempting immediate open (funding @ ${new Date(fundingTime).toISOString()}).`);
        void openPosition(ticker.symbol, fundingTime);
        return;
    }
    console.log(`[${nowIso()}] Scheduling ${ticker.symbol} for funding @ ${new Date(fundingTime).toISOString()} (open in ${Math.round(timeUntilOpen / 1000)}s).`);
    const openTimer = setTimeout(() => {
        schedules.delete(ticker.symbol);
        void openPosition(ticker.symbol, fundingTime);
    }, timeUntilOpen);
    schedules.set(ticker.symbol, { fundingTime, openTimer });
}
async function pollTickers() {
    if (!tradingEnabled)
        return;
    try {
        const tickers = await (0, bybit_top_funding_1.fetchTopFundingTickers)(50);
        tickers.forEach((ticker) => {
            latestTickers.set(ticker.symbol, ticker);
        });
        const sorted = tickers
            .filter((ticker) => ticker.nextFundingTime)
            .sort((a, b) => {
            const rateDiff = (b.fundingRateAbs ?? 0) - (a.fundingRateAbs ?? 0);
            if (rateDiff !== 0)
                return rateDiff;
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
    }
    catch (error) {
        console.error(`[${nowIso()}] Failed to poll tickers:`, error);
    }
}
async function shutdown() {
    if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = undefined;
    }
    if (monitorHandle) {
        clearInterval(monitorHandle);
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

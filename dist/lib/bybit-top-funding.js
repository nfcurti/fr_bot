"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchTopFundingTickers = fetchTopFundingTickers;
exports.fetchFundingTicker = fetchFundingTicker;
const BYBIT_TICKERS_ENDPOINT = "https://api.bybit.com/v5/market/tickers?category=linear";
function parseNumber(value) {
    if (value === undefined || value === null)
        return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
async function parseTickerResponse(response) {
    if (!response.ok) {
        throw new Error(`Bybit API error: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    if (payload.retCode !== 0 || !payload.result?.list) {
        throw new Error(payload.retMsg ?? "Unexpected response shape from Bybit API.");
    }
    return payload.result.list;
}
function transformTicker(ticker) {
    const fundingRate = parseNumber(ticker.fundingRate);
    if (fundingRate === undefined)
        return undefined;
    return {
        symbol: ticker.symbol,
        fundingRate,
        fundingRateAbs: Math.abs(fundingRate),
        markPrice: parseNumber(ticker.markPrice),
        lastPrice: parseNumber(ticker.lastPrice),
        bidPrice: parseNumber(ticker.bidPrice),
        askPrice: parseNumber(ticker.askPrice),
        price24hPcnt: parseNumber(ticker.price24hPcnt),
        highPrice24h: parseNumber(ticker.highPrice24h),
        lowPrice24h: parseNumber(ticker.lowPrice24h),
        turnover24h: parseNumber(ticker.turnover24h),
        volume24h: parseNumber(ticker.volume24h),
        nextFundingTime: ticker.nextFundingTime,
        fundingInterval: ticker.fundingInterval,
    };
}
async function fetchTopFundingTickers(limit = 10) {
    const response = await fetch(BYBIT_TICKERS_ENDPOINT, {
        cache: "no-store",
    });
    const tickers = await parseTickerResponse(response);
    return tickers
        .map(transformTicker)
        .filter((ticker) => ticker !== undefined)
        .sort((a, b) => b.fundingRateAbs - a.fundingRateAbs)
        .slice(0, limit);
}
async function fetchFundingTicker(symbol) {
    const response = await fetch(`${BYBIT_TICKERS_ENDPOINT}&symbol=${symbol}`, {
        cache: "no-store",
    });
    const tickers = await parseTickerResponse(response);
    const [first] = tickers;
    const transformed = first ? transformTicker(first) : undefined;
    return transformed ?? null;
}

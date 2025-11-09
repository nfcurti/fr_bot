const BYBIT_TICKERS_ENDPOINT = "https://api.bybit.com/v5/market/tickers?category=linear";

export interface BybitFundingTicker {
  symbol: string;
  fundingRate: number;
  fundingRateAbs: number;
  markPrice?: number;
  lastPrice?: number;
  bidPrice?: number;
  askPrice?: number;
  price24hPcnt?: number;
  highPrice24h?: number;
  lowPrice24h?: number;
  turnover24h?: number;
  volume24h?: number;
  nextFundingTime?: string;
  fundingInterval?: string;
}

interface BybitTicker {
  symbol: string;
  fundingRate?: string;
  lastPrice?: string;
  price24hPcnt?: string;
  markPrice?: string;
  bidPrice?: string;
  askPrice?: string;
  highPrice24h?: string;
  lowPrice24h?: string;
  turnover24h?: string;
  volume24h?: string;
  nextFundingTime?: string;
  fundingInterval?: string;
}

function parseNumber(value?: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function parseTickerResponse(response: Response): Promise<BybitTicker[]> {
  if (!response.ok) {
    throw new Error(`Bybit API error: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();

  if (payload.retCode !== 0 || !payload.result?.list) {
    throw new Error(payload.retMsg ?? "Unexpected response shape from Bybit API.");
  }

  return payload.result.list as BybitTicker[];
}

function transformTicker(ticker: BybitTicker): BybitFundingTicker | undefined {
  const fundingRate = parseNumber(ticker.fundingRate);

  if (fundingRate === undefined) return undefined;

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

export async function fetchTopFundingTickers(limit: number = 10): Promise<BybitFundingTicker[]> {
  const response = await fetch(BYBIT_TICKERS_ENDPOINT, {
    cache: "no-store",
  });

  const tickers = await parseTickerResponse(response);

  return tickers
    .map(transformTicker)
    .filter((ticker): ticker is BybitFundingTicker => ticker !== undefined)
    .sort((a, b) => b.fundingRateAbs - a.fundingRateAbs)
    .slice(0, limit);
}

export async function fetchFundingTicker(symbol: string): Promise<BybitFundingTicker | null> {
  const response = await fetch(`${BYBIT_TICKERS_ENDPOINT}&symbol=${symbol}`, {
    cache: "no-store",
  });

  const tickers = await parseTickerResponse(response);

  const [first] = tickers;
  const transformed = first ? transformTicker(first) : undefined;

  return transformed ?? null;
}


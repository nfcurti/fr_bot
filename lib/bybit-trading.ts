import crypto from "crypto";

export type TradeSide = "Buy" | "Sell";
export type BybitSide = TradeSide;

export interface LimitOrderInput {
  symbol: string;
  side: BybitSide;
  price: number;
  qty: number;
  reduceOnly?: boolean;
}

export interface InstrumentFilters {
  minOrderQty: number;
  qtyStep: number;
  priceStep: number;
}

export interface ClosedPnlEntry {
  symbol: string;
  side: BybitSide;
  qty: number;
  closedPnl: number;
  execFee: number;
  fundingFee: number;
  avgEntryPrice?: number;
  avgExitPrice?: number;
  orderId?: string;
  createdTime: number;
  updatedTime: number;
}

export interface WalletBalance {
  coin: string;
  totalEquity: number;
  walletBalance: number;
  availableBalance: number;
}

const API_BASE_URL = process.env.BYBIT_API_BASE_URL ?? "https://api.bybit.com";
const RECV_WINDOW = "5000";
const instrumentCache = new Map<string, InstrumentFilters>();

function assertCredentials() {
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error("Bybit API credentials are not configured. Set BYBIT_API_KEY and BYBIT_API_SECRET.");
  }

  return { apiKey, apiSecret };
}

function createSignature({
  apiSecret,
  timestamp,
  apiKey,
  body,
}: {
  apiSecret: string;
  timestamp: string;
  apiKey: string;
  body: string;
}) {
  const payload = `${timestamp}${apiKey}${RECV_WINDOW}${body}`;
  return crypto.createHmac("sha256", apiSecret).update(payload).digest("hex");
}

function toNumber(value?: string) {
  if (!value) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function decimalPlaces(step: number): number {
  const parts = step.toString().split(".");
  return parts.length === 2 ? parts[1].length : 0;
}

export async function getInstrumentFilters(symbol: string): Promise<InstrumentFilters> {
  const cached = instrumentCache.get(symbol);
  if (cached) return cached;

  const url = new URL("/v5/market/instruments-info", API_BASE_URL);
  url.searchParams.set("category", "linear");
  url.searchParams.set("symbol", symbol);

  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch instrument info: ${response.status} ${response.statusText} - ${text}`);
  }

  const payload = await response.json();

  if (payload.retCode !== 0 || !payload.result?.list?.[0]) {
    throw new Error(payload.retMsg ?? "Invalid instrument info response from Bybit.");
  }

  const info = payload.result.list[0];
  const lot = info.lotSizeFilter ?? {};
  const price = info.priceFilter ?? {};

  const minOrderQty = toNumber(lot.minOrderQty);
  const qtyStep = toNumber(lot.qtyStep);
  const priceStep = toNumber(price.tickSize);

  if (!minOrderQty || !qtyStep || !priceStep) {
    throw new Error("Incomplete instrument filters returned by Bybit.");
  }

  const filters: InstrumentFilters = { minOrderQty, qtyStep, priceStep };
  instrumentCache.set(symbol, filters);
  return filters;
}

export function normaliseQty(rawQty: number, filters: InstrumentFilters): { qty: number; precision: number } {
  const { minOrderQty, qtyStep } = filters;

  const precision = decimalPlaces(qtyStep);
  const units = Math.floor(rawQty / qtyStep);
  const minUnits = Math.ceil(minOrderQty / qtyStep - 1e-9);
  const adjustedUnits = Math.max(units, minUnits);
  const qty = adjustedUnits * qtyStep;

  if (qty < minOrderQty) {
    throw new Error(
      `Calculated order size ${qty} is below Bybit minimum ${minOrderQty}. Increase trade notional for this symbol.`
    );
  }

  return { qty, precision };
}

export function normalisePrice(rawPrice: number, priceStep: number): { price: number; precision: number } {
  const precision = decimalPlaces(priceStep);
  const units = Math.round(rawPrice / priceStep);
  const price = units * priceStep;
  return { price, precision };
}

export async function prepareLimitOrder(input: LimitOrderInput) {
  const filters = await getInstrumentFilters(input.symbol);

  const { qty, precision: qtyPrecision } = normaliseQty(input.qty, filters);
  const { price, precision: pricePrecision } = normalisePrice(input.price, filters.priceStep);

  return {
    qty,
    price,
    qtyPrecision,
    pricePrecision,
  };
}

export async function placeLimitOrder(input: LimitOrderInput) {
  const { apiKey, apiSecret } = assertCredentials();
  const { qty, price, qtyPrecision, pricePrecision } = await prepareLimitOrder(input);
  const orderLinkId = `fund-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;

  const url = new URL("/v5/order/create", API_BASE_URL);
  const timestamp = Date.now().toString();

  const body = JSON.stringify({
    category: "linear",
    symbol: input.symbol,
    side: input.side,
    orderType: "Limit",
    qty: qty.toFixed(qtyPrecision),
    price: price.toFixed(pricePrecision),
    timeInForce: "GTC",
    reduceOnly: input.reduceOnly ?? false,
    orderLinkId,
  });

  const signature = createSignature({ apiSecret, timestamp, apiKey, body });

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": signature,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bybit order request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const result = await response.json();

  if (result.retCode !== 0) {
    throw new Error(result.retMsg ?? "Bybit rejected the order request.");
  }

  return {
    orderLinkId,
    orderId: result.result?.orderId,
    qty: qty.toFixed(qtyPrecision),
    price: price.toFixed(pricePrecision),
    response: result,
  };
}

export async function getPositionSize(symbol: string): Promise<number> {
  const { apiKey, apiSecret } = assertCredentials();

  const url = new URL("/v5/position/list", API_BASE_URL);
  url.searchParams.set("category", "linear");
  url.searchParams.set("symbol", symbol);

  const queryString = url.searchParams.toString();
  const timestamp = Date.now().toString();

  const signaturePayload = `${timestamp}${apiKey}${RECV_WINDOW}${queryString}`;
  const signature = crypto.createHmac("sha256", apiSecret).update(signaturePayload).digest("hex");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": signature,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch position info: ${response.status} ${response.statusText} - ${text}`);
  }

  const payload = await response.json();

  if (payload.retCode !== 0) {
    throw new Error(payload.retMsg ?? "Bybit rejected the position request.");
  }

  const size = payload.result?.list?.[0]?.size ?? "0";
  const parsed = Number(size);
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

export async function getOrderExecutions(orderLinkId: string) {
  const { apiKey, apiSecret } = assertCredentials();

  const url = new URL("/v5/execution/list", API_BASE_URL);
  url.searchParams.set("category", "linear");
  url.searchParams.set("orderLinkId", orderLinkId);

  const queryString = url.searchParams.toString();
  const timestamp = Date.now().toString();
  const signaturePayload = `${timestamp}${apiKey}${RECV_WINDOW}${queryString}`;
  const signature = crypto.createHmac("sha256", apiSecret).update(signaturePayload).digest("hex");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": signature,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch execution info: ${response.status} ${response.statusText} - ${text}`);
  }

  const payload = await response.json();

  if (payload.retCode !== 0) {
    throw new Error(payload.retMsg ?? "Bybit rejected the execution request.");
  }

  return payload.result?.list ?? [];
}

export async function getFundingHistory(symbol: string, startTime?: number, endTime?: number) {
  const { apiKey, apiSecret } = assertCredentials();

  const url = new URL("/v5/account/funding/history", API_BASE_URL);
  url.searchParams.set("category", "linear");
  url.searchParams.set("symbol", symbol);
  if (startTime) {
    url.searchParams.set("startTime", Math.floor(startTime).toString());
  }
  if (endTime) {
    url.searchParams.set("endTime", Math.floor(endTime).toString());
  }

  const queryString = url.searchParams.toString();
  const timestamp = Date.now().toString();
  const payload = `${timestamp}${apiKey}${RECV_WINDOW}${queryString}`;
  const signature = crypto.createHmac("sha256", apiSecret).update(payload).digest("hex");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": signature,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch funding history: ${response.status} ${response.statusText} - ${text}`);
  }

  const data = await response.json();

  if (data.retCode !== 0) {
    throw new Error(data.retMsg ?? "Bybit rejected the funding history request.");
  }

  return data.result?.list ?? [];
}

export async function getWalletBalance(coin: string = "USDT"): Promise<WalletBalance> {
  const { apiKey, apiSecret } = assertCredentials();

  const accountType = process.env.BYBIT_ACCOUNT_TYPE ?? "UNIFIED";
  const url = new URL("/v5/account/wallet-balance", API_BASE_URL);
  url.searchParams.set("accountType", accountType);
  if (coin) {
    url.searchParams.set("coin", coin);
  }

  const queryString = url.searchParams.toString();
  const timestamp = Date.now().toString();
  const payload = `${timestamp}${apiKey}${RECV_WINDOW}${queryString}`;
  const signature = crypto.createHmac("sha256", apiSecret).update(payload).digest("hex");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": signature,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch wallet balance: ${response.status} ${response.statusText} - ${text}`);
  }

  const payloadJson = await response.json();

  if (payloadJson.retCode !== 0 || !payloadJson.result?.list?.[0]) {
    throw new Error(payloadJson.retMsg ?? "Bybit rejected the wallet balance request.");
  }

  const account = payloadJson.result.list[0];
  const coins: Array<Record<string, unknown>> = account.coin ?? [];
  const target = coins.find((entry) => entry.coin === coin) ?? coins[0];

  if (!target) {
    throw new Error(`Wallet balance for coin ${coin} not available.`);
  }

  const toNum = (value: unknown): number => {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  };

  const totalEquity = toNum(target.equity ?? target.walletBalance ?? target.totalEquity);
  const walletBalance = toNum(target.walletBalance ?? target.wallet ?? totalEquity);
  const availableBalance = toNum(target.availableToWithdraw ?? target.availableBalance ?? target.available ?? walletBalance);
  const resolvedCoin = typeof target.coin === "string" ? target.coin : coin;

  return {
    coin: resolvedCoin,
    totalEquity,
    walletBalance,
    availableBalance,
  };
}

export async function getClosedPnl(startTime?: number, endTime?: number): Promise<ClosedPnlEntry[]> {
  const { apiKey, apiSecret } = assertCredentials();

  const url = new URL("/v5/position/closed-pnl", API_BASE_URL);
  url.searchParams.set("category", "linear");
  if (startTime) {
    url.searchParams.set("startTime", Math.floor(startTime).toString());
  }
  if (endTime) {
    url.searchParams.set("endTime", Math.floor(endTime).toString());
  }

  const queryString = url.searchParams.toString();
  const timestamp = Date.now().toString();
  const payload = `${timestamp}${apiKey}${RECV_WINDOW}${queryString}`;
  const signature = crypto.createHmac("sha256", apiSecret).update(payload).digest("hex");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": signature,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch closed PnL: ${response.status} ${response.statusText} - ${text}`);
  }

  const data = await response.json();

  if (data.retCode !== 0) {
    throw new Error(data.retMsg ?? "Bybit rejected the closed PnL request.");
  }

  return (data.result?.list ?? []).map((entry: any) => ({
    symbol: entry.symbol,
    side: entry.side,
    qty: Number(entry.qty ?? 0),
    closedPnl: Number(entry.closedPnl ?? 0),
    execFee: Number(entry.execFee ?? 0),
    fundingFee: Number(entry.fundingFee ?? 0),
    avgEntryPrice: entry.avgEntryPrice ? Number(entry.avgEntryPrice) : undefined,
    avgExitPrice: entry.avgExitPrice ? Number(entry.avgExitPrice) : undefined,
    orderId: entry.orderId,
    createdTime: Number(entry.createdTime ?? 0),
    updatedTime: Number(entry.updatedTime ?? 0),
  }));
}


"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getInstrumentFilters = getInstrumentFilters;
exports.normaliseQty = normaliseQty;
exports.normalisePrice = normalisePrice;
exports.prepareLimitOrder = prepareLimitOrder;
exports.placeLimitOrder = placeLimitOrder;
exports.getPositionSize = getPositionSize;
exports.getOrderExecutions = getOrderExecutions;
exports.getFundingHistory = getFundingHistory;
exports.getClosedPnl = getClosedPnl;
const crypto_1 = __importDefault(require("crypto"));
const API_BASE_URL = process.env.BYBIT_API_BASE_URL ?? "https://api.bybit.com";
const RECV_WINDOW = "5000";
const instrumentCache = new Map();
function assertCredentials() {
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    if (!apiKey || !apiSecret) {
        throw new Error("Bybit API credentials are not configured. Set BYBIT_API_KEY and BYBIT_API_SECRET.");
    }
    return { apiKey, apiSecret };
}
function createSignature({ apiSecret, timestamp, apiKey, body, }) {
    const payload = `${timestamp}${apiKey}${RECV_WINDOW}${body}`;
    return crypto_1.default.createHmac("sha256", apiSecret).update(payload).digest("hex");
}
function toNumber(value) {
    if (!value)
        return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
}
function decimalPlaces(step) {
    const parts = step.toString().split(".");
    return parts.length === 2 ? parts[1].length : 0;
}
async function getInstrumentFilters(symbol) {
    const cached = instrumentCache.get(symbol);
    if (cached)
        return cached;
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
    const filters = { minOrderQty, qtyStep, priceStep };
    instrumentCache.set(symbol, filters);
    return filters;
}
function normaliseQty(rawQty, filters) {
    const { minOrderQty, qtyStep } = filters;
    const precision = decimalPlaces(qtyStep);
    const units = Math.floor(rawQty / qtyStep);
    const minUnits = Math.ceil(minOrderQty / qtyStep - 1e-9);
    const adjustedUnits = Math.max(units, minUnits);
    const qty = adjustedUnits * qtyStep;
    if (qty < minOrderQty) {
        throw new Error(`Calculated order size ${qty} is below Bybit minimum ${minOrderQty}. Increase trade notional for this symbol.`);
    }
    return { qty, precision };
}
function normalisePrice(rawPrice, priceStep) {
    const precision = decimalPlaces(priceStep);
    const units = Math.round(rawPrice / priceStep);
    const price = units * priceStep;
    return { price, precision };
}
async function prepareLimitOrder(input) {
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
async function placeLimitOrder(input) {
    const { apiKey, apiSecret } = assertCredentials();
    const { qty, price, qtyPrecision, pricePrecision } = await prepareLimitOrder(input);
    const orderLinkId = `fund-${Date.now().toString(36)}-${crypto_1.default.randomBytes(4).toString("hex")}`;
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
async function getPositionSize(symbol) {
    const { apiKey, apiSecret } = assertCredentials();
    const url = new URL("/v5/position/list", API_BASE_URL);
    url.searchParams.set("category", "linear");
    url.searchParams.set("symbol", symbol);
    const queryString = url.searchParams.toString();
    const timestamp = Date.now().toString();
    const signaturePayload = `${timestamp}${apiKey}${RECV_WINDOW}${queryString}`;
    const signature = crypto_1.default.createHmac("sha256", apiSecret).update(signaturePayload).digest("hex");
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
async function getOrderExecutions(orderLinkId) {
    const { apiKey, apiSecret } = assertCredentials();
    const url = new URL("/v5/execution/list", API_BASE_URL);
    url.searchParams.set("category", "linear");
    url.searchParams.set("orderLinkId", orderLinkId);
    const queryString = url.searchParams.toString();
    const timestamp = Date.now().toString();
    const signaturePayload = `${timestamp}${apiKey}${RECV_WINDOW}${queryString}`;
    const signature = crypto_1.default.createHmac("sha256", apiSecret).update(signaturePayload).digest("hex");
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
async function getFundingHistory(symbol, startTime, endTime) {
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
    const signature = crypto_1.default.createHmac("sha256", apiSecret).update(payload).digest("hex");
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
async function getClosedPnl(params = {}) {
    const { apiKey, apiSecret } = assertCredentials();
    const url = new URL("/v5/position/closed-pnl", API_BASE_URL);
    url.searchParams.set("category", "linear");
    if (params.symbol) {
        url.searchParams.set("symbol", params.symbol);
    }
    if (params.startTime) {
        url.searchParams.set("startTime", Math.floor(params.startTime).toString());
    }
    if (params.endTime) {
        url.searchParams.set("endTime", Math.floor(params.endTime).toString());
    }
    if (params.limit) {
        url.searchParams.set("limit", params.limit.toString());
    }
    const queryString = url.searchParams.toString();
    const timestamp = Date.now().toString();
    const payload = `${timestamp}${apiKey}${RECV_WINDOW}${queryString}`;
    const signature = crypto_1.default.createHmac("sha256", apiSecret).update(payload).digest("hex");
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
    const payloadJson = await response.json();
    if (payloadJson.retCode !== 0) {
        throw new Error(payloadJson.retMsg ?? "Bybit rejected the closed PnL request.");
    }
    const list = payloadJson.result?.list ?? [];
    return list.map((item) => {
        const toNum = (value) => {
            const num = Number(value);
            return Number.isFinite(num) ? num : 0;
        };
        const createdTime = Number(item.createdTime ?? item.created_at ?? Date.now());
        const updatedTime = Number(item.updatedTime ?? item.updated_at ?? createdTime);
        return {
            symbol: item.symbol,
            side: (item.side ?? "Buy"),
            qty: Math.abs(toNum(item.qty ?? item.closedSize)),
            closedPnl: toNum(item.closedPnl ?? item.realisedPnl ?? item.realizedPnl),
            execFee: Math.abs(toNum(item.execFee ?? item.fee)),
            fundingFee: toNum(item.fundingFee ?? item.funding),
            avgEntryPrice: toNum(item.avgEntryPrice),
            avgExitPrice: toNum(item.avgExitPrice ?? item.avgExit),
            orderId: item.orderId ?? item.order_id,
            createdTime,
            updatedTime,
        };
    });
}

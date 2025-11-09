# Bybit Funding Strategy Node Bot

A headless Node.js implementation of the Bybit funding strategy used in the web dashboard. The bot polls Bybit every second, stages limit orders 5 seconds before each qualifying funding event, and flattens positions 5 seconds after the funding timestamp. Daily trading stops automatically once the realised PnL falls below -10% of the per-trade notional ($500 → $50 stop).

## Features

- Fetches all USDT-margined perpetual tickers and tracks the top 10 by absolute funding rate (ties broken by earliest funding expiration).
- Opens a $500 notional position 5 seconds before funding when `|fundingRate| ≥ 0.5%`.
- Uses limit prices derived from the current snapshot for both entry and exit.
- Closes the entire position 5 seconds post funding with retries for partial fills.
- Calculates per-trade PnL as gross minus entry fee minus exit fee minus funding fee, mirroring Bybit’s closed-PnL breakdown.
- Halts the strategy once cumulative daily PnL ≤ -$50.

## Prerequisites

Create a `.env` file (or export env variables) containing Bybit API credentials with trading permission and read access to executions/funding history:

```
BYBIT_API_KEY=your_key
BYBIT_API_SECRET=your_secret
BYBIT_API_BASE_URL=https://api.bybit.com # optional, defaults to mainnet
```

The project reuses the shared helpers in `lib/bybit-trading.ts`, so keep this folder inside the monorepo.

## Install

```bash
cd /Users/nicolascurti/Desktop/losing_monies/automation/node-bot
npm install
```

## Run

```bash
npm run start
```

The bot logs all scheduling, entry, exit, and PnL events to stdout. Hit `Ctrl+C` to stop manually.

## Notes

- The script uses `ts-node` for convenience. Run `npm run build` to produce JavaScript output if needed.
- Ensure the hosting environment keeps the process alive (e.g. PM2, systemd, or a dedicated server). Vercel serverless functions are not suitable for long-running automation.

# @quantish/polymarket-server

Self-hosted Polymarket MCP server for trading on Polymarket prediction markets.

## Overview

This package provides an MCP (Model Context Protocol) server that enables AI agents to trade on Polymarket prediction markets via the Polygon network.

## Features

- **Full Polymarket Trading** - Buy/sell on any Polymarket market
- **Polygon Wallet Management** - Generate and manage wallets with Safe integration
- **MCP Compatible** - Works with Claude, Quantish Agent, and any MCP client
- **Self-Hostable** - Run on Railway, Fly.io, or any Node.js host

## Quick Start

```bash
git clone https://github.com/joinQuantish/polymarket-mcp
cd polymarket-mcp
npm install
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `ENCRYPTION_KEY` | Yes | 32-byte hex string for wallet encryption |
| `ENCRYPTION_IV` | Yes | 16-byte hex string for encryption IV |
| `POLYGON_RPC_URL` | Yes | Polygon RPC endpoint |
| `PORT` | No | Server port (defaults to 3000) |

### Generate Encryption Keys

```bash
# Generate ENCRYPTION_KEY (32 bytes = 64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate ENCRYPTION_IV (16 bytes = 32 hex chars)
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

## Database Setup

```bash
# Generate Prisma client
npm run db:generate

# Push schema to database
npm run db:push
```

## Running the Server

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Available Tools

### Account Management
- `pm_request_api_key` - Create account with new wallet
- `pm_get_balances` - Get USDC/MATIC balances
- `pm_export_private_key` - Export wallet private key

### Market Discovery
- `pm_search_markets` - Search Polymarket markets
- `pm_get_market` - Get market details
- `pm_get_orderbook` - Get market orderbook

### Trading
- `pm_get_quote` - Get quote for trade
- `pm_place_order` - Execute trade
- `pm_get_positions` - View current positions
- `pm_cancel_order` - Cancel open order

### Wallet Operations
- `pm_setup_wallet` - Deploy Safe wallet and set approvals
- `pm_transfer_usdc` - Transfer USDC to another address

## API Format

The server exposes a JSON-RPC 2.0 endpoint at `/mcp`:

```bash
curl -X POST https://your-server.com/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "pm_get_balances",
      "arguments": {}
    },
    "id": 1
  }'
```

## Connecting to Quantish Agent

Configure the CLI to use your server:

```bash
export POLYMARKET_MCP_URL=https://your-server.com/mcp
export POLYMARKET_API_KEY=your-api-key
quantish
```

## Development

```bash
# Install dependencies
npm install

# Generate Prisma client
npm run db:generate

# Run migrations
npm run db:push

# Start development server
npm run dev
```

## Resources

- **NPM**: [@quantish/polymarket-server](https://www.npmjs.com/package/@quantish/polymarket-server)
- **GitHub**: [joinQuantish/polymarket-mcp](https://github.com/joinQuantish/polymarket-mcp)
- **Quantish Agent**: [@quantish/agent](https://www.npmjs.com/package/@quantish/agent)
- **Polymarket Docs**: [docs.polymarket.com](https://docs.polymarket.com)

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/).

**Free for personal use, research, and non-commercial purposes.** Commercial use requires explicit permission from Quantish Inc. Contact hello@quantish.live for commercial licensing.

---

Built by [Quantish Inc.](https://quantish.live)


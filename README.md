# Polymarket MCP Server

Self-hosted MCP server for trading on Polymarket prediction markets.

## Overview

This package provides an MCP (Model Context Protocol) server that enables AI agents to trade on Polymarket prediction markets via the Polygon network.

## Features

- **Full Polymarket Trading** - Buy/sell on any Polymarket market
- **Polygon Wallet Management** - Generate and manage wallets with Safe integration
- **Gasless Transactions** - Most operations use Polymarket's relayer (no MATIC needed)
- **MCP Compatible** - Works with Claude, Cursor, and any MCP client
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
| `POLYGON_RPC_URL` | Yes | Polygon RPC endpoint |
| `BOT_SIGNING_SECRET` | No | Secret for trusted bot HMAC authentication |
| `PORT` | No | Server port (defaults to 3000) |

### Generate Encryption Keys

```bash
# Generate ENCRYPTION_KEY (32 bytes = 64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate BOT_SIGNING_SECRET (for trusted bot auth)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Database Setup

Any PostgreSQL database works. Options:

| Provider | Notes |
|----------|-------|
| **Railway** | Add PostgreSQL service, copy `DATABASE_URL` from variables |
| **Supabase** | Free tier at [supabase.com](https://supabase.com), copy connection string from Settings > Database |
| **Neon** | Serverless Postgres at [neon.tech](https://neon.tech), free tier available |
| **Local Docker** | `docker run -e POSTGRES_PASSWORD=pass -p 5432:5432 postgres` |

Set your `DATABASE_URL` then run:

```bash
# Generate Prisma client
npm run db:generate

# Create tables
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

### Account & Wallet
| Tool | Description |
|------|-------------|
| `request_api_key` | Create account with new wallet (or recover existing) |
| `setup_wallet` | Deploy Safe wallet and set approvals |
| `get_wallet_status` | Check wallet deployment and approval status |
| `get_balances` | Get USDC/MATIC balances |
| `get_deposit_addresses` | Get addresses for depositing (EVM, Solana, BTC) |
| `export_private_key` | Export wallet private key |
| `import_private_key` | Import existing wallet |

### Trading
| Tool | Description |
|------|-------------|
| `place_order` | Place buy/sell order |
| `cancel_order` | Cancel an open order |
| `cancel_all_orders` | Cancel all open orders |
| `get_orders` | Get order history |
| `execute_atomic_orders` | Execute multiple orders atomically |
| `get_orderbook` | Get market bids/asks |
| `get_price` | Get market midpoint price |

### Positions
| Tool | Description |
|------|-------------|
| `get_positions` | Get your positions |
| `sync_positions` | Sync positions from Polymarket API |
| `get_claimable_winnings` | Check redeemable winnings |
| `claim_winnings` | Claim resolved market winnings |
| `get_onchain_shares` | Get all ERC-1155 holdings (including gifted) |

### Transfers & Swaps
| Tool | Description |
|------|-------------|
| `transfer_usdc` | Send bridged USDC |
| `transfer_native_usdc` | Send Circle native USDC |
| `transfer_shares` | Send ERC-1155 shares |
| `send_matic` | Send MATIC from EOA |
| `swap_tokens` | Swap tokens via LI.FI |
| `get_swap_quote` | Get swap quote |

### API Keys
| Tool | Description |
|------|-------------|
| `list_api_keys` | List your API keys |
| `create_additional_api_key` | Create new API key |
| `revoke_api_key` | Revoke an API key |

> **Note:** Market search tools (`search_markets`, `get_market`, `get_active_markets`) are available via the [Discovery MCP](https://github.com/joinQuantish/quantish-discovery).

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
      "name": "get_balances",
      "arguments": {}
    },
    "id": 1
  }'
```

## MCP Client Configuration

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "polymarket": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://your-server.com/mcp",
        "--header",
        "x-api-key: YOUR_API_KEY"
      ]
    }
  }
}
```

## Security

### Returning Users
For security, returning users (existing `externalId`) cannot get new API keys without authentication. Options:

1. **Use existing API key** - If you have it saved
2. **HMAC Authentication** (trusted bots only) - Sign with `BOT_SIGNING_SECRET`:
   ```
   signature = HMAC-SHA256(externalId:timestamp, BOT_SIGNING_SECRET)
   ```
3. **New Account** - Use a different `externalId`

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

- **GitHub**: [joinQuantish/polymarket-mcp](https://github.com/joinQuantish/polymarket-mcp)
- **Discovery MCP**: [joinQuantish/quantish-discovery](https://github.com/joinQuantish/quantish-discovery)
- **Polymarket Docs**: [docs.polymarket.com](https://docs.polymarket.com)

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/).

**Free for personal use, research, and non-commercial purposes.** Commercial use requires explicit permission from Quantish Inc. Contact hello@quantish.live for commercial licensing.

---

Built by [Quantish Inc.](https://quantish.live)

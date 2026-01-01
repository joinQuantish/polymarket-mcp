import dotenv from 'dotenv';

dotenv.config();

// Validate required environment variables
const requiredEnvVars = [
  'DATABASE_URL',
  'ENCRYPTION_KEY',
  'ENCRYPTION_IV',
  'POLYGON_RPC_URL',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.warn(`Warning: ${envVar} is not set`);
  }
}

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',

  // Database
  databaseUrl: process.env.DATABASE_URL || '',

  // Encryption
  encryption: {
    key: process.env.ENCRYPTION_KEY || '',
    iv: process.env.ENCRYPTION_IV || '',
  },

  // Polygon Network
  polygon: {
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    chainId: parseInt(process.env.CHAIN_ID || '137', 10),
  },

  // Polymarket Endpoints
  polymarket: {
    clobApiUrl: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
    relayerUrl: process.env.RELAYER_URL || 'https://relayer-v2.polymarket.com',
    dataApiUrl: process.env.DATA_API_URL || 'https://data-api.polymarket.com',
  },

  // Builder Credentials
  // NOTE: Secret must be converted from URL-safe base64 to standard base64
  // because @polymarket/clob-client uses atob() which only accepts standard base64
  builder: {
    apiKey: process.env.POLY_BUILDER_API_KEY || '',
    secret: (() => {
      let s = process.env.POLY_BUILDER_SECRET || '';
      // Convert URL-safe base64 (-_) to standard base64 (+/)
      s = s.replace(/-/g, '+').replace(/_/g, '/');
      // Ensure proper padding
      while (s.length % 4 !== 0) s += '=';
      return s;
    })(),
    passphrase: process.env.POLY_BUILDER_PASSPHRASE || '',
  },

  // Contract Addresses (Polygon Mainnet) - matches official Polymarket CLOB client
  // Source: https://github.com/Polymarket/clob-client/blob/main/src/config.ts
  contracts: {
    usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',           // collateral
    ctf: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',            // conditionalTokens (ONLY ONE CTF!)
    ctfExchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',    // exchange
    negRiskCtfExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a', // negRiskExchange
    negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',    // negRiskAdapter
    safeFactory: '0xaacfeea03eb1561c4e67d661e40682bd20e3541b',
  },

  // Admin
  admin: {
    apiKey: process.env.ADMIN_API_KEY || 'dev-admin-key',
  },

  // SERPER API (for web scraping and news search)
  serper: {
    apiKey: process.env.SERPER_API_KEY || '',
  },

  // Quantish Discovery MCP (for semantic market search)
  quantish: {
    discoveryKey: process.env.QUANTISH_DISCOVERY_KEY || '',
    discoveryUrl: process.env.QUANTISH_DISCOVERY_URL || 'https://quantish.live/mcp',
  },

  // Rate Limiting
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 100,
  },
} as const;

export type Config = typeof config;


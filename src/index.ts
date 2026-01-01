import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import axios from 'axios';

import { config } from './config';
import { prisma } from './db';
import { userRoutes, orderRoutes, marketRoutes, adminRoutes, positionRoutes, botRoutes, searchRoutes } from './routes';
import { walletRoutes } from './routes/wallet';
import mcpRoutes from './routes/mcp';
import { apiKeyAuth, errorHandler, notFoundHandler, optionalAuth } from './middleware';

// ===========================================
// CRITICAL FIX: Axios Interceptor for POLY_ADDRESS Header
// ===========================================
// The Polymarket CLOB client library sets POLY_ADDRESS to the EOA (signer) address,
// but for Safe wallets (signature type 2), the CLOB should check the Safe's balance.
// This interceptor maps EOA -> Safe addresses for all CLOB API requests.

// Global map of EOA -> Safe addresses (populated when ClobClient is created)
export const eoaToSafeMap = new Map<string, string>();

axios.interceptors.request.use((axiosConfig) => {
  // Only intercept requests to Polymarket CLOB
  if (axiosConfig.url?.includes('clob.polymarket.com') && axiosConfig.headers) {
    const polyAddress = axiosConfig.headers['POLY_ADDRESS'] as string | undefined;
    
    if (polyAddress) {
      const safeAddress = eoaToSafeMap.get(polyAddress.toLowerCase());
      if (safeAddress) {
        console.log(`[CLOB Interceptor] Replacing POLY_ADDRESS: ${polyAddress.slice(0, 10)}... → ${safeAddress.slice(0, 10)}...`);
        axiosConfig.headers['POLY_ADDRESS'] = safeAddress;
      }
    }
  }
  return axiosConfig;
}, (error) => {
  return Promise.reject(error);
});

const app = express();

// Trust proxy for Railway's reverse proxy
app.set('trust proxy', 1);

// ===========================================
// Security Middleware
// ===========================================

// Helmet for security headers (configured for dashboard)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],  // Allow onclick handlers
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

// CORS configuration
app.use(cors({
  origin: config.isDev ? '*' : process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'x-signature', 'x-timestamp', 'x-admin-key', 'x-admin-secret', 'x-access-code', 'Authorization'],
}));

// Body parsing with security limits
app.use(express.json({ 
  limit: '1mb', // Reduced from 10mb - mitigates axios DoS vulnerability
  strict: true, // Only accept arrays and objects
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ===========================================
// Request Logging
// ===========================================
app.use((req, res, next) => {
  const start = Date.now();
  const { method, url, headers } = req;
  const apiKey = headers['x-api-key'] ? `${String(headers['x-api-key']).slice(0, 8)}...` : 'none';
  
  console.log(`→ ${method} ${url} [key: ${apiKey}]`);
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`← ${method} ${url} ${res.statusCode} (${duration}ms)`);
  });
  
  next();
});

// ===========================================
// Rate Limiting (DISABLED FOR NOW)
// ===========================================

// NOTE: Rate limiting disabled for development/testing
// Uncomment below to re-enable

// const apiLimiter = rateLimit({
//   windowMs: config.rateLimit.windowMs,
//   max: config.rateLimit.maxRequests,
//   message: { error: 'Too many requests, please try again later.' },
//   standardHeaders: true,
//   legacyHeaders: false,
// });

// const mcpLimiter = rateLimit({
//   windowMs: 60 * 1000,
//   max: 60,
//   message: { error: 'Rate limit exceeded. Please slow down.' },
//   standardHeaders: true,
//   legacyHeaders: false,
//   keyGenerator: (req) => {
//     return (req.headers['x-api-key'] as string) || req.ip || 'unknown';
//   },
// });

// Very strict limit for registration (prevent abuse) - keep this one
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 registrations per hour per IP
  message: { error: 'Too many registration attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// app.use('/api/', apiLimiter);
// app.use('/mcp', mcpLimiter);

// ===========================================
// Static Files (Dashboard)
// ===========================================

app.use(express.static(path.join(__dirname, '../public')));

// ===========================================
// Health Check (no auth)
// ===========================================

app.get('/health', async (req, res) => {
  try {
    // Check database connection
    await prisma.$queryRaw`SELECT 1`;
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
      environment: config.nodeEnv,
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Database connection failed',
    });
  }
});

// ===========================================
// API Routes
// ===========================================

// Public market data (optional auth)
app.use('/api/markets', optionalAuth, marketRoutes);

// Protected routes (require API key)
app.use('/api/users', apiKeyAuth, userRoutes);
app.use('/api/orders', apiKeyAuth, orderRoutes);
app.use('/api/positions', apiKeyAuth, positionRoutes);

// Admin routes (uses its own x-admin-key auth)
app.use('/api/admin', adminRoutes);

// Bot/Mobile app routes (public - issues new API keys)
app.use('/api/bot', botRoutes);

// Wallet routes (public - for mobile app wallet creation)
app.use('/api/wallet', walletRoutes);

// Search routes (public - proxies to Discovery MCP for embedding search)
app.use('/api/search', searchRoutes);

// ===========================================
// MCP Server Endpoint
// ===========================================

// MCP routes (uses its own auth handling for flexibility)
app.use('/mcp', mcpRoutes);

// ===========================================
// Dashboard Route
// ===========================================

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// Redirect root to dashboard
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// ===========================================
// Error Handling
// ===========================================

app.use(notFoundHandler);
app.use(errorHandler);

// ===========================================
// Server Startup
// ===========================================

async function startServer() {
  try {
    // Test database connection
    await prisma.$connect();
    console.log('✅ Database connected');

    // Start server
    app.listen(config.port, () => {
      console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🚀 Polymarket Trading Server                             ║
║                                                            ║
║   Status:      Running                                     ║
║   Port:        ${config.port.toString().padEnd(40)}║
║   Environment: ${config.nodeEnv.padEnd(40)}║
║   Dashboard:   http://localhost:${config.port}/dashboard${' '.repeat(16)}║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...');
  await prisma.$disconnect();
  process.exit(0);
});

// Start the server
startServer();

export { app };

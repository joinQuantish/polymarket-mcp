#!/usr/bin/env node
/**
 * Polymarket Trading MCP Server - STDIO Mode
 * 
 * This is a standalone entry point for running the MCP server locally
 * using STDIO transport (for Claude Desktop or other local MCP clients).
 * 
 * Usage:
 *   npx tsx src/mcp-server.ts
 *   
 * Or add to Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "polymarket": {
 *         "command": "npx",
 *         "args": ["tsx", "path/to/src/mcp-server.ts"]
 *       }
 *     }
 *   }
 */

import dotenv from 'dotenv';
dotenv.config();

import { runStdioServer } from './mcp/server';

runStdioServer().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});


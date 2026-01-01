import { Router, Request, Response, NextFunction } from 'express';
import { getMCPHandler } from '../mcp/http-handler';

const router = Router();
const mcpHandler = getMCPHandler();

/**
 * MCP Endpoint
 * Supports POST (JSON-RPC requests), GET (SSE stream), DELETE (session termination)
 * 
 * Authentication: x-api-key header required
 * - Admin key: Full access to all operations
 * - User API key: Restricted to own wallet
 */
router.all('/', async (req: Request, res: Response) => {
  await mcpHandler.handleRequest(req, res);
});

/**
 * MCP Discovery endpoint
 * Returns server capabilities and connection info
 */
router.get('/info', (req: Request, res: Response) => {
  res.json({
    name: 'Polymarket Trading MCP Server',
    version: '1.0.0',
    description: 'MCP server for Polymarket prediction market trading',
    protocolVersion: '2024-11-05',
    transport: 'streamable-http',
    authentication: {
      type: 'api-key',
      header: 'x-api-key',
      description: 'API key for authentication. Admin key for full access, or user-specific key for wallet-restricted access.'
    },
    capabilities: {
      tools: true,
      resources: false,
      prompts: false
    },
    endpoints: {
      mcp: '/mcp',
      info: '/mcp/info'
    }
  });
});

/**
 * Tool documentation endpoint
 */
router.get('/tools', async (req: Request, res: Response) => {
  const { TOOLS } = await import('../mcp/tools');
  
  res.json({
    count: TOOLS.length,
    tools: TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  });
});

export default router;


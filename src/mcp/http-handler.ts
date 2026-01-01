import { Request, Response } from 'express';
import { prisma } from '../db';
import { TOOLS, executeTool, ToolContext } from './tools';
import { getApiKeyService } from '../services/apikey.service';
import { v4 as uuidv4 } from 'uuid';

// JSON-RPC types
interface JSONRPCRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * MCP HTTP Handler
 * Implements Streamable HTTP transport for MCP with secure API key authentication
 * 
 * SECURITY:
 * - API key is extracted from x-api-key header
 * - API key is mapped to user via hashed lookup
 * - User ID is NEVER accepted from tool arguments
 * - Only request_api_key tool works without authentication
 * - Optional HMAC signature verification for extra security
 * 
 * HMAC HEADERS (optional):
 * - x-signature: HMAC-SHA256(timestamp + method + path + body, secret)
 * - x-timestamp: Unix timestamp in milliseconds
 */
export class MCPHttpHandler {
  private apiKeyService = getApiKeyService();

  /**
   * Handle incoming MCP requests
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const signature = req.headers['x-signature'] as string | undefined;
    const timestamp = req.headers['x-timestamp'] as string | undefined;
    
    // Authenticate user from API key (if provided)
    let context: ToolContext = {
      userId: null,
      isAuthenticated: false,
    };

    if (apiKey) {
      console.log(`[MCP Auth] Received API key: ${apiKey.substring(0, 15)}...`);
      
      // Check if it's the admin key
      if (apiKey === process.env.API_ADMIN_KEY) {
        // Admin has full access but still needs to specify actions
        // For admin, we allow them to operate but they can't impersonate users
        context = {
          userId: null,
          isAuthenticated: true, // Admin is authenticated but has no userId
        };
        console.log('[MCP Auth] Admin key validated');
      } else {
        // Validate user API key
        const validation = await this.apiKeyService.validateApiKey(apiKey);
        console.log(`[MCP Auth] Validation result: ${validation ? 'SUCCESS - userId: ' + validation.userId : 'FAILED - key not found in database'}`);
        
        if (validation) {
          // If signature headers are provided, verify HMAC
          if (signature && timestamp && validation.encryptedSecret) {
            const body = JSON.stringify(req.body);
            // Use originalUrl to get full path including mount point (e.g., /mcp not /)
            const path = req.originalUrl.split('?')[0]; // Remove query string if any
            const method = req.method;
            
            const isValidSignature = this.apiKeyService.verifyHmacSignature(
              signature,
              timestamp,
              method,
              path,
              body,
              validation.encryptedSecret
            );
            
            if (!isValidSignature) {
              res.status(401).json({
                jsonrpc: '2.0',
                id: null,
                error: {
                  code: -32000,
                  message: 'Invalid signature',
                  data: 'HMAC signature verification failed. Check your secret and signature calculation.',
                },
              });
              return;
            }
          }
          
          context = {
            userId: validation.userId,
            isAuthenticated: true,
            user: validation.user,
          };
        }
      }
    }

    // Handle GET request (SSE stream for server-to-client messages)
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      // Send initial event
      const eventId = uuidv4();
      res.write(`id: ${eventId}\ndata: \n\n`);
      
      // Keep connection alive
      const keepAlive = setInterval(() => {
        res.write(': keepalive\n\n');
      }, 30000);

      req.on('close', () => {
        clearInterval(keepAlive);
      });
      
      return;
    }

    // Handle POST request (JSON-RPC messages)
    if (req.method === 'POST') {
      const message = req.body as JSONRPCRequest;
      
      if (!message || typeof message !== 'object') {
        this.sendError(res, null, -32700, 'Parse error');
        return;
      }

      // Handle JSON-RPC request
      const response = await this.processRequest(message, context, req);
      
      res.setHeader('Content-Type', 'application/json');
      res.json(response);
      return;
    }

    // Handle DELETE request (session termination)
    if (req.method === 'DELETE') {
      res.status(200).send();
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  }

  /**
   * Process a JSON-RPC request
   */
  private async processRequest(
    request: JSONRPCRequest,
    context: ToolContext,
    req: Request
  ): Promise<JSONRPCResponse> {
    const { id = null, method, params } = request;
    const responseId = id ?? null;

    try {
      switch (method) {
        case 'initialize':
          return this.handleInitialize(responseId);

        case 'tools/list':
          return this.handleListTools(responseId);

        case 'tools/call':
          return await this.handleCallTool(responseId, params, context, req);

        case 'ping':
          return { jsonrpc: '2.0', id: responseId, result: {} };

        default:
          return this.createError(responseId, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return this.createError(responseId, -32603, message);
    }
  }

  /**
   * Handle initialize request
   */
  private handleInitialize(id: string | number | null): JSONRPCResponse {
    const sessionId = uuidv4();
    
    return {
      jsonrpc: '2.0',
      id: id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'polymarket-trading',
          version: '1.0.0',
          description: 'Secure Polymarket trading server with API key authentication',
        },
        sessionId,
      },
    };
  }

  /**
   * Handle tools/list request
   */
  private handleListTools(id: string | number | null): JSONRPCResponse {
    return {
      jsonrpc: '2.0',
      id: id,
      result: {
        tools: TOOLS,
      },
    };
  }

  /**
   * Handle tools/call request
   * 
   * SECURITY: User context is derived from API key header, NOT from arguments
   */
  private async handleCallTool(
    id: string | number | null,
    params: unknown,
    context: ToolContext,
    req: Request
  ): Promise<JSONRPCResponse> {
    const { name, arguments: args } = params as { name: string; arguments: Record<string, unknown> };

    // Validate tool exists
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) {
      return this.createError(id, -32602, `Unknown tool: ${name}`);
    }

    // Special case: request_api_key and import_private_key don't require authentication
    const isPublicTool = name === 'request_api_key' || name === 'import_private_key';

    // For non-public tools, require authentication
    if (!isPublicTool && !context.isAuthenticated) {
      return {
        jsonrpc: '2.0',
        id: id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Authentication required',
              message: 'Please include your API key in the x-api-key header. If you do not have an API key, call request_api_key first.',
            }),
          }],
          isError: true,
        },
      };
    }

    // For user-specific operations (not admin, not public), require userId in context
    if (!isPublicTool && context.isAuthenticated && !context.userId) {
      // This is an admin key - they can only use public tools or view-only tools
      // For now, we'll allow market data tools for admin
      const adminAllowedTools = [
        'polymarket_search_fallback', 'get_market', 'get_orderbook', 'get_price', 'get_active_markets'
      ];
      if (!adminAllowedTools.includes(name)) {
        return {
          jsonrpc: '2.0',
          id: id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'User-specific operation requires user API key',
                message: 'Admin key cannot perform user-specific operations. Use a user API key instead.',
              }),
            }],
            isError: true,
          },
        };
      }
    }

    try {
      // Execute tool with secure context (userId from header, NOT arguments)
      const result = await executeTool(name, args || {}, context);
      
      // Log activity (async, don't wait)
      if (context.userId) {
        prisma.activityLog.create({
          data: {
            userId: context.userId,
            action: `MCP_TOOL_${name.toUpperCase()}`,
            resource: 'mcp',
            resourceId: name,
            details: { success: true },
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
          },
        }).catch(() => {});
      }
      
      return {
        jsonrpc: '2.0',
        id: id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      
      // Log error (async, don't wait)
      if (context.userId) {
        prisma.activityLog.create({
          data: {
            userId: context.userId,
            action: `MCP_TOOL_${name.toUpperCase()}`,
            resource: 'mcp',
            resourceId: name,
            success: false,
            errorMessage: message,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
          },
        }).catch(() => {});
      }
      
      return {
        jsonrpc: '2.0',
        id: id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: message }),
          }],
          isError: true,
        },
      };
    }
  }

  /**
   * Send JSON-RPC error response
   */
  private sendError(
    res: Response,
    id: string | number | null,
    code: number,
    message: string
  ): void {
    res.status(400).json(this.createError(id, code, message));
  }

  /**
   * Create JSON-RPC error object
   */
  private createError(
    id: string | number | null,
    code: number,
    message: string
  ): JSONRPCResponse {
    return {
      jsonrpc: '2.0',
      id: id,
      error: {
        code,
        message,
      },
    };
  }
}

// Singleton instance
let mcpHandler: MCPHttpHandler | null = null;

export function getMCPHandler(): MCPHttpHandler {
  if (!mcpHandler) {
    mcpHandler = new MCPHttpHandler();
  }
  return mcpHandler;
}

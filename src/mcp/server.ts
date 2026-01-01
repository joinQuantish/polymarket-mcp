import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, executeTool, ToolContext } from './tools';
import { getApiKeyService } from '../services/apikey.service';

// Re-export tools for compatibility
export { TOOLS, executeTool };

/**
 * MCP Server for stdio transport (local testing)
 * 
 * For stdio transport, the API key can be provided via:
 * 1. MCP_API_KEY environment variable
 * 2. As part of the initialization (not implemented yet)
 * 
 * The request_api_key tool is the only tool that works without authentication.
 */

// Create and run the MCP server
export async function createMCPServer(): Promise<Server> {
  const apiKeyService = getApiKeyService();
  
  const server = new Server(
    {
      name: 'polymarket-trading',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Get context from environment API key (for stdio transport)
  const getContextFromEnv = async (): Promise<ToolContext> => {
    const envApiKey = process.env.MCP_API_KEY;
    
    if (!envApiKey) {
      return { userId: null, isAuthenticated: false };
    }

    const validation = await apiKeyService.validateApiKey(envApiKey);
    if (validation) {
      return {
        userId: validation.userId,
        isAuthenticated: true,
        user: validation.user,
      };
    }

    return { userId: null, isAuthenticated: false };
  };

  // Register tool handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    try {
      // Get context from environment for stdio transport
      const context = await getContextFromEnv();
      
      const result = await executeTool(name, args || {}, context);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: errorMessage }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// Run as STDIO server (for local testing with Claude Desktop or other MCP clients)
export async function runStdioServer(): Promise<void> {
  const server = await createMCPServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Polymarket MCP Server running on stdio');
}

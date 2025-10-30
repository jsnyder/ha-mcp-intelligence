import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import compression from 'compression';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BackgroundIndexer } from '../intelligence/background-indexer.js';
import { DiagnoseEntityTool } from '../tools/diagnose-entity.js';
import { AnalyzeErrorsTool } from '../tools/analyze-errors.js';
import { AgentTools } from '../tools/agent-tools.js';
import { Logger } from '../utils/logger.js';

export interface MCPServerConfig {
  port: number;
  authRequired: boolean;
  indexer: BackgroundIndexer;
  agentTools?: AgentTools;
}

interface AuthenticatedRequest extends Request {
  token?: string;
}

export class MCPServer {
  private logger = new Logger('MCPServer');
  private app: express.Application;
  private config: MCPServerConfig;
  private server: Server;
  private httpServer: ReturnType<typeof express.prototype.listen> | null = null;

  // Tool instances
  private diagnoseEntityTool: DiagnoseEntityTool;
  private analyzeErrorsTool: AnalyzeErrorsTool;
  private agentTools?: AgentTools;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.app = express();

    // Initialize MCP SDK Server
    this.server = new Server(
      {
        name: 'ha-mcp-intelligence',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize tools
    this.diagnoseEntityTool = new DiagnoseEntityTool(config.indexer);
    this.analyzeErrorsTool = new AnalyzeErrorsTool(config.indexer);
    this.agentTools = config.agentTools;

    this.setupMiddleware();
    this.setupMCPHandlers();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // CORS
    this.app.use(cors());

    // Compression
    this.app.use(compression());

    // JSON parsing
    this.app.use(express.json({ limit: '10mb' }));

    // Authentication middleware
    if (this.config.authRequired) {
      this.app.use((req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        // Skip auth for health check
        if (req.path === '/health') {
          return next();
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return res.status(401).json({
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: 'Unauthorized: Bearer token required',
            },
            id: null,
          });
        }

        req.token = authHeader.substring(7);
        next();
      });
    }

    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      this.logger.debug(`${req.method} ${req.path}`);
      next();
    });
  }

  private setupMCPHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = [
        this.diagnoseEntityTool.getToolDefinition(),
        this.analyzeErrorsTool.getToolDefinition(),
      ];

      // Add agent tools if available
      if (this.agentTools) {
        tools.push(
          {
            name: 'ha_agent.start_session',
            description: 'Start a new long-lived agent session',
            inputSchema: {
              type: 'object',
              properties: {
                model: { type: 'object', description: 'Model configuration' },
                budgets: { type: 'object', description: 'Budget limits' },
                policy: { type: 'object', description: 'Session policy' },
                preferences: { type: 'object', description: 'User preferences' },
              },
            },
          },
          {
            name: 'ha_agent.send_message',
            description: 'Send a message to an agent session (creates continuation)',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                message: { type: 'string', description: 'User message' },
                allow_tools: { type: 'boolean', description: 'Allow tool usage' },
                max_steps: { type: 'number', description: 'Maximum planning steps' },
                time_budget_ms: { type: 'number', description: 'Time budget in milliseconds' },
              },
              required: ['session_id', 'message'],
            },
          },
          {
            name: 'ha_agent.await_continuation',
            description: 'Wait for a continuation to complete',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                continuation_id: { type: 'string', description: 'Continuation ID' },
                timeout_ms: { type: 'number', description: 'Timeout in milliseconds' },
              },
              required: ['session_id', 'continuation_id'],
            },
          },
          {
            name: 'ha_agent.cancel',
            description: 'Cancel a running continuation',
            inputSchema: {
              type: 'object',
              properties: {
                continuation_id: { type: 'string', description: 'Continuation ID' },
                reason: { type: 'string', description: 'Cancellation reason' },
              },
              required: ['continuation_id'],
            },
          },
          {
            name: 'ha_agent.get_session',
            description: 'Get session state',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
              },
              required: ['session_id'],
            },
          },
          {
            name: 'ha_agent.end_session',
            description: 'End a session',
            inputSchema: {
              type: 'object',
              properties: {
                session_id: { type: 'string', description: 'Session ID' },
                reason: { type: 'string', description: 'End reason' },
              },
              required: ['session_id'],
            },
          },
          {
            name: 'ha_agent.list_sessions',
            description: 'List active sessions',
            inputSchema: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['active', 'expired'], description: 'Filter by status' },
                limit: { type: 'number', description: 'Maximum sessions to return' },
              },
            },
          },
          {
            name: 'ha_agent.ask',
            description: 'One-shot agent query (creates temporary session)',
            inputSchema: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'User message' },
                model: { type: 'object', description: 'Model configuration' },
                budgets: { type: 'object', description: 'Budget limits' },
                allow_tools: { type: 'boolean', description: 'Allow tool usage' },
              },
              required: ['message'],
            },
          }
        );
      }

      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      this.logger.info(`Tool call: ${name}`, args);

      try {
        let result: unknown;

        switch (name) {
          case 'diagnose_entity':
            result = await this.diagnoseEntityTool.execute(args || {});
            break;

          case 'analyze_errors':
            result = await this.analyzeErrorsTool.execute(args || {});
            break;

          // Agent tools
          case 'ha_agent.start_session':
            if (!this.agentTools) throw new Error('Agent tools not initialized');
            result = await this.agentTools.startSession(args as never);
            break;

          case 'ha_agent.send_message':
            if (!this.agentTools) throw new Error('Agent tools not initialized');
            result = await this.agentTools.sendMessage(args as never);
            break;

          case 'ha_agent.await_continuation':
            if (!this.agentTools) throw new Error('Agent tools not initialized');
            result = await this.agentTools.awaitContinuation(args as never);
            break;

          case 'ha_agent.cancel':
            if (!this.agentTools) throw new Error('Agent tools not initialized');
            result = await this.agentTools.cancel(args as never);
            break;

          case 'ha_agent.get_session':
            if (!this.agentTools) throw new Error('Agent tools not initialized');
            result = await this.agentTools.getSession(args as never);
            break;

          case 'ha_agent.end_session':
            if (!this.agentTools) throw new Error('Agent tools not initialized');
            result = await this.agentTools.endSession(args as never);
            break;

          case 'ha_agent.list_sessions':
            if (!this.agentTools) throw new Error('Agent tools not initialized');
            result = await this.agentTools.listSessions(args as never);
            break;

          case 'ha_agent.ask':
            if (!this.agentTools) throw new Error('Agent tools not initialized');
            result = await this.agentTools.ask(args as never);
            break;

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        this.logger.error(`Tool execution failed: ${name}`, error);

        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      const lastUpdate = this.config.indexer.getLastUpdate();
      res.json({
        status: 'healthy',
        version: '0.1.0',
        lastIndexUpdate: lastUpdate?.toISOString() || null,
        entityCount: this.config.indexer.getAllEntities().length,
      });
    });

    // MCP endpoint (JSON-RPC 2.0)
    this.app.post('/mcp', async (req: Request, res: Response) => {
      try {
        const { jsonrpc, method, params, id } = req.body;

        if (jsonrpc !== '2.0') {
          return res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32600,
              message: 'Invalid Request: jsonrpc must be "2.0"',
            },
            id: id || null,
          });
        }

        // Route to MCP SDK server
        let response: unknown;

        if (method === 'tools/list') {
          response = await this.server.request(
            { method: 'tools/list', params: {} },
            ListToolsRequestSchema
          );
        } else if (method === 'tools/call') {
          response = await this.server.request(
            { method: 'tools/call', params },
            CallToolRequestSchema
          );
        } else {
          return res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
            id,
          });
        }

        res.json({
          jsonrpc: '2.0',
          result: response,
          id,
        });
      } catch (error) {
        this.logger.error('MCP request failed', error);

        const errorMessage = error instanceof Error ? error.message : String(error);
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: `Internal error: ${errorMessage}`,
          },
          id: req.body.id || null,
        });
      }
    });

    // SSE endpoint for MCP (future: streaming support)
    this.app.get('/mcp', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Send initial connection message
      res.write('data: {"type":"connected","version":"0.1.0"}\n\n');

      // Keep connection alive
      const keepAlive = setInterval(() => {
        res.write(':keep-alive\n\n');
      }, 30000);

      _req.on('close', () => {
        clearInterval(keepAlive);
        res.end();
      });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = this.app.listen(this.config.port, () => {
        this.logger.info(`MCP Intelligence Server listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      return new Promise((resolve, reject) => {
        this.httpServer!.close((error: Error | undefined) => {
          if (error) {
            this.logger.error('Error stopping server', error);
            reject(error);
          } else {
            this.logger.info('Server stopped');
            resolve();
          }
        });
      });
    }
  }
}

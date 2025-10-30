#!/usr/bin/env node

// Load environment variables from .env file (for local development)
import { config as loadEnv } from 'dotenv';
loadEnv();

import { join } from 'path';
import { MCPServer } from './server/mcp-server.js';
import { BackgroundIndexer } from './intelligence/background-indexer.js';
import { SupervisorClient } from './server/supervisor-client.js';
import { SessionManager } from './agent/session-manager.js';
import { ContinuationRunner } from './agent/continuation-runner.js';
import { ToolRegistry } from './agent/tool-registry.js';
import { ArtifactStore } from './agent/artifact-store.js';
import { FileLayout } from './agent/file-layout.js';
import { AgentTools } from './tools/agent-tools.js';
import { Logger } from './utils/logger.js';

const logger = new Logger('Main');

async function main() {
  const config = {
    port: 3123,
    logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warning' | 'error',
    cacheTTL: parseInt(process.env.CACHE_TTL_SECONDS || '60', 10),
    authRequired: process.env.AUTH_REQUIRED === 'true',
    supervisorToken: process.env.SUPERVISOR_TOKEN || '',
    dataPath: process.env.DATA_PATH || '/data',
  };

  logger.info('Starting HA MCP Intelligence Server (with Agent)', config);

  // Initialize Supervisor client
  const haClient = new SupervisorClient({
    supervisorToken: config.supervisorToken,
  });

  // Start background indexer
  const indexer = new BackgroundIndexer({
    supervisorToken: config.supervisorToken,
    ttlSeconds: config.cacheTTL,
  });

  await indexer.start();
  logger.info('Background indexer started');

  // Initialize agent components
  logger.info('Initializing agent system...');

  const fileLayout = new FileLayout(config.dataPath);
  await fileLayout.init();

  const artifactStore = new ArtifactStore(join(config.dataPath, 'artifacts'));
  await artifactStore.init();

  const toolRegistry = new ToolRegistry();

  const sessionManager = new SessionManager({
    dataPath: config.dataPath,
    defaultModel: {
      provider: 'openrouter',
      modelId: 'google/gemini-2.0-flash-exp:free',
      temperature: 0.7,
    },
  });

  await sessionManager.init();
  logger.info(`Loaded ${sessionManager.listSessions().length} existing sessions`);

  const continuationRunner = new ContinuationRunner({
    dataPath: config.dataPath,
    fileLayout,
    toolRegistry,
    artifactStore,
    haClient,
    indexer,
  });

  const agentTools = new AgentTools({
    sessionManager,
    continuationRunner,
  });

  logger.info('Agent system initialized');

  // Start MCP server (now with agent tools)
  const server = new MCPServer({
    port: config.port,
    authRequired: config.authRequired,
    indexer,
    agentTools,
  });

  await server.start();
  logger.info(`MCP server listening on port ${config.port}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    await server.stop();
    await indexer.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error('Fatal error', error);
  process.exit(1);
});

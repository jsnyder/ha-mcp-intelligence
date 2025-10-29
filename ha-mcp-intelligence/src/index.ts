#!/usr/bin/env node

// Load environment variables from .env file (for local development)
import { config as loadEnv } from 'dotenv';
loadEnv();

import { MCPServer } from './server/mcp-server.js';
import { BackgroundIndexer } from './intelligence/background-indexer.js';
import { Logger } from './utils/logger.js';

const logger = new Logger('Main');

async function main() {
  const config = {
    port: 3123,
    logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warning' | 'error',
    cacheTTL: parseInt(process.env.CACHE_TTL_SECONDS || '60', 10),
    authRequired: process.env.AUTH_REQUIRED === 'true',
    supervisorToken: process.env.SUPERVISOR_TOKEN || '',
  };

  logger.info('Starting HA MCP Intelligence Server', config);

  // Start background indexer
  const indexer = new BackgroundIndexer({
    supervisorToken: config.supervisorToken,
    ttlSeconds: config.cacheTTL,
  });

  await indexer.start();
  logger.info('Background indexer started');

  // Start MCP server
  const server = new MCPServer({
    port: config.port,
    authRequired: config.authRequired,
    indexer,
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

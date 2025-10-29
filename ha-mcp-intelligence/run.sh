#!/usr/bin/env bashio

# Get configuration
LOG_LEVEL=$(bashio::config 'log_level')
CACHE_TTL=$(bashio::config 'cache_ttl_seconds')
AUTH_REQUIRED=$(bashio::config 'auth_required')

# Get Supervisor token
SUPERVISOR_TOKEN=$(bashio::supervisor.token)

# Export environment variables
export LOG_LEVEL="${LOG_LEVEL}"
export CACHE_TTL_SECONDS="${CACHE_TTL}"
export AUTH_REQUIRED="${AUTH_REQUIRED}"
export SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}"

bashio::log.info "Starting Home Assistant MCP Intelligence Server..."
bashio::log.info "Log level: ${LOG_LEVEL}"
bashio::log.info "Cache TTL: ${CACHE_TTL}s"
bashio::log.info "Auth required: ${AUTH_REQUIRED}"

# Start the server
cd /app
exec node dist/index.js

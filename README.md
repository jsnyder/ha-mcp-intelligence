# Home Assistant MCP Intelligence Server

Server-side MCP intelligence for Home Assistant development workflows. Provides context-aware analysis, root cause detection, and intelligent diagnostics without requiring SSH access.

## Features

### 🔍 Phase 1 (Current)
- **diagnose_entity**: Complete entity diagnosis with root cause analysis and impact assessment
- **analyze_errors**: Error log analysis with cascade detection and recommendations
- **Background Indexer**: Cached dependency graph with 60s TTL for fast responses
- **Bearer Token Authentication**: Secure access using Home Assistant long-lived tokens

### 🚀 Phase 2 (Planned)
- **analyze_config_change**: Configuration change impact analysis
- **Advanced correlations**: Performance bottlenecks, integration health checks
- **Streaming support**: Real-time updates via SSE

## Installation

### As Home Assistant Add-on

1. Add this repository to your Home Assistant add-on store
2. Install "Home Assistant MCP Intelligence Server"
3. Configure and start the add-on

### Manual Installation (Development)

```bash
cd homeassistant-mcp-addon
npm install
npm run build
```

## Configuration

### Add-on Options

```yaml
log_level: info           # debug | info | warning | error
cache_ttl_seconds: 60     # Background indexer refresh interval
auth_required: true       # Require Bearer token authentication
```

### Client Configuration (Claude Code)

Edit `~/.config/claudecode/config.json`:

```json
{
  "mcpServers": {
    "home-assistant": {
      "command": "/opt/homebrew/bin/npx",
      "args": [
        "-y",
        "supergateway",
        "--sse",
        "http://assistant.5745.house:3123/mcp",
        "--auth",
        "Bearer YOUR_HA_LONG_LIVED_TOKEN"
      ]
    }
  }
}
```

## Available Tools

### diagnose_entity

Diagnose an entity and identify root causes of issues.

**Parameters:**
- `entity_id` (required): Entity ID to diagnose (e.g., `sensor.living_room_temperature`)
- `include_root_cause` (optional): Include root cause analysis (default: true)
- `include_impact` (optional): Include impact analysis (default: true)

**Example:**
```typescript
await mcp.callTool('diagnose_entity', {
  entity_id: 'sensor.hvac_total_power_estimate',
  include_root_cause: true,
  include_impact: true
});
```

**Returns:**
- Current state and status
- Device and area information
- Root cause chain (if unavailable)
- Affected entities and automations
- Actionable recommendations

### analyze_errors

Analyze recent errors and warnings in Home Assistant.

**Parameters:**
- `timeframe` (optional): `1h` | `24h` | `7d` (default: `24h`)
- `severity` (optional): `warning` | `error` | `critical` (default: `warning`)

**Example:**
```typescript
await mcp.callTool('analyze_errors', {
  timeframe: '24h',
  severity: 'error'
});
```

**Returns:**
- Parsed error incidents with timestamps
- Cascade detection (errors causing other errors)
- Root cause identification
- Prioritized recommendations

## Architecture

```
┌────────────────────────────────────────────────────┐
│        HA Add-on: MCP Intelligence Server           │
│                                                     │
│  ┌─────────────────────────────────────────────┐  │
│  │   Background Indexer (60s TTL)              │  │
│  │   • Entity/Device/Area registries           │  │
│  │   • Dependency graph builder                │  │
│  │   • Root cause analyzer                     │  │
│  └─────────────────────────────────────────────┘  │
│                      ▲                             │
│                      │                             │
│  ┌─────────────────────────────────────────────┐  │
│  │   Supervisor Proxy Client                    │  │
│  │   • WebSocket API connection                │  │
│  │   • HTTP API fallback                       │  │
│  │   • Automatic authentication                │  │
│  └─────────────────────────────────────────────┘  │
│                      ▲                             │
│                      │                             │
│  ┌─────────────────────────────────────────────┐  │
│  │   MCP Server (HTTP/SSE on port 3123)        │  │
│  │   • Bearer token authentication             │  │
│  │   • JSON-RPC 2.0 endpoint                   │  │
│  │   • SSE streaming support                   │  │
│  └─────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
                       ▲
                       │ HTTP/SSE
                       │
┌────────────────────────────────────────────────────┐
│              Claude Code (MCP Client)               │
│              via supergateway                      │
└────────────────────────────────────────────────────┘
```

## Development

### Building

```bash
npm run build
```

### Local Testing

```bash
# Start with environment variables
export SUPERVISOR_TOKEN="your_token_here"
export LOG_LEVEL="debug"
export CACHE_TTL_SECONDS="60"
export AUTH_REQUIRED="false"

npm start
```

### Health Check

```bash
curl http://localhost:3123/health
```

## Security

- **Bearer Token Required**: All requests (except `/health`) require authentication
- **Supervisor Token**: Add-on uses Supervisor token internally for HA API access
- **Read-Only**: Phase 1 tools are read-only (no mutations)
- **No File Access**: Uses WebSocket/HTTP APIs exclusively (no file parsing)

## Troubleshooting

### Add-on won't start

Check logs:
```bash
ha addons logs ha-mcp-intelligence
```

Common issues:
- Supervisor token not available (should be automatic in add-on)
- Port 3123 already in use
- Invalid configuration

### Claude Code can't connect

1. Verify add-on is running: `ha addons info ha-mcp-intelligence`
2. Check health endpoint: `curl http://assistant.5745.house:3123/health`
3. Verify long-lived token is valid
4. Check Claude Code logs for auth errors

### Tools return errors

1. Check if entity exists: `ha states info sensor.example`
2. Verify background indexer is refreshing (check `/health`)
3. Review add-on logs for correlation engine errors

## References

- **[Implementation Plan](../documentation/development/ha-mcp-addon-implementation-plan.md)** - Complete design
- **[MCP Specification](https://modelcontextprotocol.io/)** - Protocol details
- **[HA WebSocket API](https://developers.home-assistant.io/docs/api/websocket)** - Data sources

---

**Version**: 0.1.0 (Phase 1)
**Status**: Development
**License**: MIT

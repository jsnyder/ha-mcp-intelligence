# Development Guide

## Quick Start

### Prerequisites
- Node.js 22.x or higher
- npm or yarn
- Access to Home Assistant instance
- Home Assistant long-lived access token

### Setup

1. **Install dependencies**
```bash
cd homeassistant-mcp-addon
npm install
```

2. **Create environment file**
```bash
cat > .env <<EOF
SUPERVISOR_TOKEN=your_ha_token_here
LOG_LEVEL=debug
CACHE_TTL_SECONDS=60
AUTH_REQUIRED=false
EOF
```

3. **Build TypeScript**
```bash
npm run build
```

4. **Run locally**
```bash
npm start
```

The server will start on `http://localhost:3123`.

### Development Workflow

#### Watch Mode
```bash
# Terminal 1: Watch and rebuild TypeScript
npm run dev

# Terminal 2: Run server with auto-restart (requires nodemon)
npx nodemon dist/index.js
```

#### Testing Endpoints

**Health Check**
```bash
curl http://localhost:3123/health
```

**List Tools (MCP)**
```bash
curl -X POST http://localhost:3123/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "params": {},
    "id": 1
  }'
```

**Diagnose Entity**
```bash
curl -X POST http://localhost:3123/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "diagnose_entity",
      "arguments": {
        "entity_id": "sensor.living_room_temperature"
      }
    },
    "id": 2
  }'
```

**Analyze Errors**
```bash
curl -X POST http://localhost:3123/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "analyze_errors",
      "arguments": {
        "timeframe": "24h",
        "severity": "error"
      }
    },
    "id": 3
  }'
```

## Project Structure

```
homeassistant-mcp-addon/
├── src/
│   ├── index.ts                    # Entry point
│   ├── server/
│   │   ├── mcp-server.ts          # MCP server + HTTP endpoints
│   │   └── supervisor-client.ts   # HA WebSocket/HTTP client
│   ├── intelligence/
│   │   └── background-indexer.ts  # Cached dependency graph
│   ├── tools/
│   │   ├── diagnose-entity.ts     # Entity diagnosis tool
│   │   └── analyze-errors.ts      # Error analysis tool
│   └── utils/
│       └── logger.ts               # Logging utility
├── config.yaml                     # HA add-on configuration
├── Dockerfile                      # Container build
├── run.sh                          # Add-on startup script
├── package.json                    # Node.js dependencies
└── tsconfig.json                   # TypeScript config
```

## Architecture Components

### 1. MCP Server (`mcp-server.ts`)
- Handles HTTP requests on port 3123
- Implements JSON-RPC 2.0 for MCP protocol
- Bearer token authentication
- SSE endpoint for future streaming
- Routes tool calls to appropriate handlers

### 2. Supervisor Client (`supervisor-client.ts`)
- WebSocket connection to `ws://supervisor/core/websocket`
- HTTP fallback for history/logs via `http://supervisor/core/api`
- Automatic authentication with Supervisor token
- Promise-based request/response handling

### 3. Background Indexer (`background-indexer.ts`)
- Refreshes every 60 seconds (configurable)
- Caches:
  - Entity states (all ~400 entities)
  - Device registry
  - Entity registry
  - Area registry
  - Dependency graph (built from template parsing)
- Provides fast lookups for tools

### 4. Tools
Each tool implements:
- `getToolDefinition()`: MCP tool schema
- `execute(args)`: Tool logic

## Adding New Tools

1. **Create tool file** in `src/tools/`
```typescript
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { BackgroundIndexer } from '../intelligence/background-indexer.js';

export class MyNewTool {
  constructor(private indexer: BackgroundIndexer) {}

  getToolDefinition(): Tool {
    return {
      name: 'my_new_tool',
      description: 'What this tool does',
      inputSchema: {
        type: 'object',
        properties: {
          param1: { type: 'string', description: 'First parameter' }
        },
        required: ['param1']
      }
    };
  }

  async execute(args: Record<string, unknown>): Promise<unknown> {
    // Tool implementation
    return { result: 'success' };
  }
}
```

2. **Register in MCP server** (`mcp-server.ts`)
```typescript
// In constructor
this.myNewTool = new MyNewTool(config.indexer);

// In setupMCPHandlers() - add to tools array
tools: [
  this.diagnoseEntityTool.getToolDefinition(),
  this.analyzeErrorsTool.getToolDefinition(),
  this.myNewTool.getToolDefinition(), // Add here
]

// In CallToolRequestSchema handler - add case
case 'my_new_tool':
  result = await this.myNewTool.execute(args);
  break;
```

3. **Rebuild and test**
```bash
npm run build
npm start
```

## Testing

### Unit Tests (Future)
```bash
npm test
```

### Integration Testing

1. **Start HA MCP server**
```bash
npm start
```

2. **Configure Claude Code** to use local server:
```json
{
  "home-assistant": {
    "command": "/opt/homebrew/bin/npx",
    "args": [
      "-y", "supergateway", "--sse",
      "http://localhost:3123/mcp"
    ]
  }
}
```

3. **Test via Claude Code**
```
Ask Claude: "Diagnose sensor.living_room_temperature"
```

## Debugging

### Enable Debug Logging
```bash
export LOG_LEVEL=debug
npm start
```

### WebSocket Connection Issues
- Check if Supervisor is accessible: `curl http://supervisor/core/api`
- Verify `SUPERVISOR_TOKEN` is set
- Check Home Assistant is running

### Tool Execution Errors
- Review logs for stack traces
- Use debug logging to see request/response
- Test Supervisor API directly:
```bash
wscat -c ws://supervisor/core/websocket
```

### Performance Issues
- Check background indexer refresh time in logs
- Monitor entity count: `curl http://localhost:3123/health`
- Adjust `CACHE_TTL_SECONDS` if needed

## Deployment as Add-on

### Build Add-on Image

1. **Update version** in `config.yaml` and `package.json`

2. **Build for architecture**
```bash
docker build --build-arg BUILD_ARCH=amd64 -t ha-mcp-intelligence .
```

3. **Test in Home Assistant**
- Copy add-on directory to `/addons/` in HA
- Refresh add-on store
- Install and configure

### Publish to Repository

1. **Create GitHub repository** (if not exists)
2. **Tag release**
```bash
git tag -a v0.1.0 -m "Phase 1 release"
git push origin v0.1.0
```

3. **Build multi-arch images** (GitHub Actions)
4. **Update add-on repository** with new version

## Code Style

### TypeScript Guidelines
- **No `any` types** - Use `unknown` with type guards
- **Strict mode enabled** - All compiler checks on
- **Explicit return types** - Functions must declare return types
- **Interface over type** - Prefer interfaces for object shapes
- **Async/await** - Use promises, avoid callbacks

### Naming Conventions
- **Files**: kebab-case (`diagnose-entity.ts`)
- **Classes**: PascalCase (`DiagnoseEntityTool`)
- **Functions**: camelCase (`getToolDefinition()`)
- **Constants**: UPPER_SNAKE_CASE (`CACHE_TTL`)

### Error Handling
- **Throw descriptive errors**: Include context
- **Log errors before throwing**: Help debugging
- **Return structured results**: Don't throw for business logic failures

## Resources

- **[Implementation Plan](../../documentation/development/ha-mcp-addon-implementation-plan.md)** - Complete architecture
- **[MCP SDK Docs](https://github.com/modelcontextprotocol/typescript-sdk)** - Protocol implementation
- **[Home Assistant API](https://developers.home-assistant.io/docs/api/websocket)** - WebSocket API reference
- **[Supervisor API](https://developers.home-assistant.io/docs/supervisor/api)** - Add-on API access

---

**Questions?** Open an issue in the repository.

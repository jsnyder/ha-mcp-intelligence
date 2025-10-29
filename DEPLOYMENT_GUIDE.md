# Deployment Guide - HA MCP Intelligence Server

## Quick Start

The add-on has been deployed to Home Assistant at `/addons/ha-mcp-intelligence`.

### Install from Home Assistant UI

1. **Add Local Repository**
   - Go to **Settings** → **Add-ons** → **Add-on Store**
   - Click **⋮** (three dots, top right)
   - Select **Repositories**
   - Add repository: `/addons`
   - Click **Add** then **Close**

2. **Install Add-on**
   - Refresh the add-on store page
   - Scroll to "Local add-ons" section
   - Find **Home Assistant MCP Intelligence Server**
   - Click on it
   - Click **Install** (this will build the Docker image)
   - Wait 2-5 minutes for build to complete

3. **Configure**
   - After installation, go to the **Configuration** tab
   - Set options:
     ```yaml
     log_level: debug  # For initial testing
     cache_ttl_seconds: 60
     auth_required: false  # For testing (set true in production)
     ```
   - Click **Save**

4. **Start the Add-on**
   - Go to the **Info** tab
   - Click **Start**
   - Monitor the **Log** tab for startup messages

5. **Verify**
   - Look for log messages:
     ```
     [INFO] Starting HA MCP Intelligence Server
     [INFO] Background indexer started
     [INFO] MCP server listening on port 3123
     ```
   - Check health endpoint from your Mac:
     ```bash
     curl http://assistant.5745.house:3123/health
     ```

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Home Assistant Supervisor (Docker Network)             │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │ HA Core                                          │  │
│  │ ws://supervisor/core/websocket                   │  │
│  │ http://supervisor/core/api                       │  │
│  └──────────────────────────────────────────────────┘  │
│                       ↕                                 │
│  ┌──────────────────────────────────────────────────┐  │
│  │ HA MCP Intelligence Add-on                       │  │
│  │ - Port 3123: MCP HTTP/SSE server                 │  │
│  │ - Connects to Supervisor via internal network   │  │
│  │ - Builds dependency graph (60s refresh)          │  │
│  │ - Provides diagnose_entity tool                  │  │
│  │ - Provides analyze_errors tool                   │  │
│  └──────────────────────────────────────────────────┘  │
│                       ↕                                 │
└────────────────────────│────────────────────────────────┘
                         │ Port 3123 exposed
                         ↓
                ┌────────────────────┐
                │ Claude Code (Mac)  │
                │ MCP Client         │
                └────────────────────┘
```

## Claude Code Integration

After the add-on is running, configure Claude Code to use it:

### Option 1: Update MCP Config (Recommended)

Edit `~/.config/claudecode/config.json`:

```json
{
  "mcpServers": {
    "home-assistant-intelligence": {
      "command": "/opt/homebrew/bin/npx",
      "args": [
        "-y",
        "supergateway",
        "--sse",
        "http://assistant.5745.house:3123/mcp"
      ]
    }
  }
}
```

### Option 2: Test with curl

```bash
# List available tools
curl -X POST http://assistant.5745.house:3123/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "params": {},
    "id": 1
  }'

# Diagnose an entity
curl -X POST http://assistant.5745.house:3123/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "diagnose_entity",
      "arguments": {"entity_id": "sensor.living_room_temperature"}
    },
    "id": 2
  }'
```

## Troubleshooting

### Add-on won't install
- Check logs during build: Settings → Add-ons → HA MCP Intelligence → Log
- Common issue: Missing dependencies (build will show npm errors)
- Solution: Check package.json has all dependencies

### Add-on won't start
1. Check logs for errors
2. Common issues:
   - WebSocket connection failed → Normal, will retry with exponential backoff
   - Port 3123 already in use → Check for conflicting services
   - Memory limits → Increase in config if needed

### Can't connect from Claude Code
1. Verify add-on is running:
   ```bash
   curl http://assistant.5745.house:3123/health
   ```
2. Check firewall isn't blocking port 3123
3. Verify Claude Code MCP config is correct

### WebSocket connection errors
- Expected during first 5 connection attempts (exponential backoff)
- Will retry: 1s, 2s, 4s, 8s, 16s delays
- Should connect on retry #2 or #3 inside Docker network

## Logs

### View via UI
- Settings → Add-ons → HA MCP Intelligence Server → Log tab

### View via SSH
```bash
ssh -i ~/.ssh/id_ed25519_ha root@assistant.5745.house
docker logs addon_<hash>_ha-mcp-intelligence
```

### Log Levels
- **debug**: Verbose logging (use for troubleshooting)
- **info**: Normal operation (recommended for testing)
- **warning**: Only warnings and errors
- **error**: Only errors

## Performance

Expected resource usage:
- **Memory**: ~100-150 MB
- **CPU**: <5% (idle), ~10% during refresh cycles
- **Network**: Minimal (WebSocket connection + periodic state fetches)

## Security

### Production Settings
```yaml
auth_required: true  # Enable Bearer token authentication
log_level: info       # Reduce log verbosity
cache_ttl_seconds: 60 # Balance freshness vs load
```

### Token Authentication (when enabled)
Clients must send:
```
Authorization: Bearer <supervisor_token>
```

The add-on automatically gets the Supervisor token from the environment.

## Updates

To deploy updates:

```bash
# From homeassistant-mcp-addon directory
./deploy-local.sh
```

Then in HA UI:
1. Go to add-on page
2. Click **Rebuild** (if code changed)
3. Click **Restart** (if config changed only)

## Next Steps

Once the add-on is running:
1. ✅ Test health endpoint
2. ✅ Test diagnose_entity with a real sensor
3. ✅ Test analyze_errors with recent logs
4. ✅ Integrate with Claude Code
5. 📝 Document any issues found
6. 🚀 Use in development workflow!

---

**Deployment Date**: 2025-10-29
**Version**: 0.1.0
**Status**: Ready for testing

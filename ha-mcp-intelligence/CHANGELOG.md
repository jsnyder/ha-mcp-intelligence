# Changelog

All notable changes to the Home Assistant MCP Intelligence Server will be documented in this file.

## [0.1.0] - 2025-10-29

### Added - Phase 1 MVP
- **Core Infrastructure**
  - HTTP/SSE transport on port 3123
  - Bearer token authentication
  - Background indexer with 60s TTL
  - Supervisor proxy client (WebSocket + HTTP APIs)
  - MCP SDK integration with JSON-RPC 2.0

- **Tools Implemented**
  - `diagnose_entity`: Complete entity diagnosis with root cause analysis
  - `analyze_errors`: Error log analysis with cascade detection

- **Intelligence Features**
  - Dependency graph builder with template parsing
  - Root cause chain traversal
  - Error cascade correlation
  - Entity impact analysis

- **Documentation**
  - Complete README with examples
  - Implementation plan (v2.0.0)
  - TypeScript source with comprehensive types

### Technical Details
- Node.js 22.x runtime
- TypeScript 5.7+ with strict mode
- Express.js for HTTP server
- ws library for WebSocket client
- @modelcontextprotocol/sdk for MCP protocol

### Security
- All requests require Bearer token (except /health)
- Read-only operations in Phase 1
- No file system access (API-only)
- Secure credential handling via Supervisor

---

## Roadmap

### [0.2.0] - Phase 2 (Planned)
- `analyze_config_change` tool
- Performance bottleneck detection
- Integration health checks
- Streaming SSE updates
- Enhanced cascade algorithms

### [0.3.0] - Phase 3 (Future)
- Package file mapping
- Advanced template dependency parsing
- Historical trend analysis
- Predictive failure detection

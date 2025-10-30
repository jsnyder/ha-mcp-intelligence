# HA MCP Agent with Continuations - Architecture Specification

**Version**: 0.2.0
**Status**: Design Phase
**Date**: 2025-10-30

## Overview

This document specifies the architecture for transforming the ha-mcp-intelligence add-on from a traditional "tool invocation" pattern into an **agent-in-container** pattern with long-lived sessions and continuations.

### Key Requirements

1. **Long-lived sessions** - Maintain conversational state across multiple turns
2. **Continuations** - Resume/cancel/retry long-running operations
3. **Arbitrary analysis** - Not limited to predefined tool schemas
4. **Autonomous iteration** - Agent can loop and make decisions
5. **High-context models** - Support Gemini 2M tokens and similar

## Core Concepts

### Session vs Continuation

- **Session** (`session_id`): Long-lived conversation container (days/weeks)
  - Maintains memory, preferences, context
  - Contains multiple turns (continuations)
  - Survives server restarts

- **Continuation** (`continuation_id`): Single turn or operation
  - Represents one user message → agent response
  - Can be streamed, cancelled, resumed
  - Persisted with full step logs

### State Management

```
Session (persistent)
├── Rolling Summary (2K tokens)
├── Facts (durable insights)
├── Last K Messages (full content, K=6)
├── Entity Context (cached from indexer)
└── Continuations (references)
    ├── Continuation 1 (step logs, artifacts)
    ├── Continuation 2
    └── ...
```

## TypeScript Interfaces

### Core Types

```typescript
interface AgentSession {
  id: string;                    // ULID
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'ended' | 'expired';
  model: ModelConfig;
  budgets: Budgets;
  policy: SessionPolicy;
  memory: SessionMemory;
  messages: TurnMessageMeta[];   // Lightweight refs only
  preferences?: UserPreferences;
  ctx: SessionContext;
  locks: SessionLocks;
  openContinuations: Set<string>;
  stats: SessionStats;
  version: number;               // Optimistic concurrency
}

interface SessionMemory {
  rollingSummary: string;        // <2K tokens
  facts: KeyFact[];              // Durable insights
  pins: PinnedContext[];         // Always-include snippets
  lastK: TurnMessage[];          // Last 6 full messages
}

interface Continuation {
  id: string;                    // ULID
  sessionId: string;
  status: 'pending' | 'running' | 'streaming' | 'completed' |
          'failed' | 'cancelled' | 'expired' | 'interrupted';
  createdAt: number;
  updatedAt: number;
  request: ContinuationRequest;
  response?: ContinuationResponse;
  stepLog: StepLogEntry[];
  artifacts?: ArtifactRef[];
  error?: ContinuationError;
}

interface ContinuationRequest {
  message: string;
  allowTools: boolean;
  maxSteps: number;
  timeBudgetMs: number;
  plannerHints?: PlannerHints;
  idempotencyKey?: string;       // Dedupe protection
}

interface ContinuationResponse {
  finalMessage: string;
  reasoningSummary?: string;
  citations?: Citation[];
  followUps?: string[];
}

interface StepLogEntry {
  ts: number;
  type: 'plan' | 'tool_call' | 'tool_result' | 'retrieval' |
        'observed_event' | 'summary' | 'error';
  detail: any;
}
```

### Tool Registry

```typescript
interface ToolSpec {
  name: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
  invoke: (args: any, ctx: ToolInvokeContext) => Promise<any>;
  cost?: ToolCost;
  safety?: ToolSafety;
}

interface ToolInvokeContext {
  session: AgentSession;
  signal: AbortSignal;
  logger: (e: StepLogEntry) => void;
  haClient: HAClient;
  index: IndexClient;
  artifacts: ArtifactStore;
}
```

## MCP Tool Schema

### Primary Tools

```typescript
// Start a new long-lived session
ha_agent.start_session({
  model?: ModelConfig,
  budgets?: Budgets,
  policy?: SessionPolicy,
  preferences?: UserPreferences
}) → { session_id: string }

// Send message in a session (creates continuation)
ha_agent.send_message({
  session_id: string,
  message: string,
  planner_hints?: PlannerHints,
  allow_tools?: boolean,
  time_budget_ms?: number,
  idempotency_key?: string,
  stream?: boolean
}) → { continuation_id: string, acknowledged: boolean }

// Wait for continuation to complete
ha_agent.await_continuation({
  continuation_id: string,
  timeout_ms?: number
}) → {
  status: string,
  response?: ContinuationResponse,
  artifacts?: ArtifactRef[]
}

// Cancel running continuation
ha_agent.cancel({
  continuation_id: string,
  reason?: string
}) → { status: 'cancelled' | 'not_found' | 'already_final' }

// Get session state
ha_agent.get_session({
  session_id: string
}) → { session: AgentSessionSummary }

// End session
ha_agent.end_session({
  session_id: string,
  reason?: string
}) → { status: 'ended' }
```

### One-Shot Tool

```typescript
// Simplified one-shot (creates temp session)
ha_agent.ask({
  message: string,
  model?: ModelConfig,
  budgets?: Budgets,
  allow_tools?: boolean,
  stream?: boolean
}) → {
  response: ContinuationResponse,
  artifacts?: ArtifactRef[]
}
```

### Optional Tools

```typescript
// Resume interrupted continuation
ha_agent.resume({
  continuation_id: string
}) → { /* same as await_continuation */ }

// List active sessions (debugging)
ha_agent.list_sessions({
  status?: 'active' | 'expired',
  limit?: number
}) → { sessions: AgentSessionSummary[] }
```

## Persistence Strategy

### File Layout

```
/data/
├── sessions/
│   └── {sessionId}/
│       ├── session.json           # AgentSession (no large content)
│       ├── turns/
│       │   ├── {contId}.json      # Continuation record
│       │   └── ...
│       └── logs/
│           ├── {contId}.log       # NDJSON StepLogEntry WAL
│           └── ...
├── artifacts/
│   └── {artifactId}               # Large results, plots, etc.
└── index/
    └── meta.json                  # Indexer version tracking
```

### Persistence Rules

1. **Session lifecycle:**
   - On create/end: write `session.json`
   - Every N turns: compact + update rolling summary

2. **Continuation lifecycle:**
   - On create: write `turns/{contId}.json` with `status=pending`
   - During execution: stream steps to `logs/{contId}.log` (NDJSON)
   - Every 2s or 5 steps: flush `turns/{contId}.json` status
   - On completion: write response, update `session.json` metadata

3. **Crash recovery:**
   - Scan all sessions on startup
   - Mark running/streaming/pending → `interrupted`
   - Allow `ha_agent.resume()` or manual retry

4. **TTL & cleanup:**
   - Sessions: 7 days idle
   - Continuations: 24h retention
   - Background sweeper: archive or delete expired

### Memory Management

- **In-Memory**: Active sessions, lastK messages, rollingSummary
- **Persisted**: All step logs, artifacts, metadata
- **Compact Strategy**:
  - Keep last 6 full messages
  - Rolling summary <2K tokens
  - Facts array for durable insights
  - Don't persist full transcripts in `session.json`

## Streaming & Events

### SSE Event Channel

```
/events/{session_id}
```

Event types:
```typescript
{
  type: 'progress' | 'step' | 'partial' | 'final',
  session_id: string,
  continuation_id: string,
  payload: {
    message?: string,
    step?: StepLogEntry,
    partial_response?: string,
    final_response?: ContinuationResponse
  }
}
```

### Streaming Flow

1. Client calls `send_message(stream: true)`
2. Server creates continuation, returns `continuation_id`
3. Client subscribes to `/events/{session_id}`
4. Server emits:
   - `progress`: "Gathering related entities and logs"
   - `step`: Tool call details
   - `partial`: Incremental response chunks
   - `final`: Complete response
5. Client can call `await_continuation()` or rely on SSE

## Tool Integration

### Hybrid Pattern

Existing tools remain callable **both**:
- **Directly via MCP** (deterministic, auditable)
- **By the agent internally** (same code paths)

```typescript
const registry = new InMemoryToolRegistry();
registry.register(diagnoseEntityTool);
registry.register(analyzeErrorsTool);
registry.register(indexSearchTool);
registry.register(haStateQueryTool);
```

### Agent Context

Agent has access to:
- Background indexer (entity/device/area graph)
- HA WebSocket/REST APIs
- Tool registry (all existing + new tools)
- Artifact storage
- Session memory

## Model Strategy

### Context Building

Per-turn prompt construction:
```typescript
{
  system: [policy, tool catalog, session policy],
  session_summary: [rollingSummary, facts, pins],
  recent_messages: lastK,
  task: [user message, planner_hints, budgets],
  rag_snippets: [from index lookups]
}
```

### Token Budgeting

- **High-context models** (Gemini 2M): Include more lastK, relevant logs
- **Standard models** (<200K): Compact summary + recent context
- **Soft cap**: `Budgets.maxTokensPerTurn` (estimate with tokenizer)

### Model Switching

- Store `model` in `session.model`
- Allow per-turn override with transfer summary
- Or enforce `policy.enforceFixedModel = true`

## Default Configuration

```typescript
const DEFAULTS = {
  memory: {
    lastK: 6,                      // Last 6 full messages
    summaryTokens: 2000,           // Rolling summary target
  },
  budgets: {
    maxSteps: 8,
    maxToolCalls: 16,
    maxDurationMs: 120_000,        // 2 minutes
    maxTokensPerTurn: 100_000,
  },
  ttl: {
    sessionIdleDays: 7,
    continuationRetentionHours: 24,
  },
  streaming: {
    partialUpdateIntervalMs: 500,  // Coalesced chunks
    flushCadenceMs: 2000,           // Persistence
  },
  concurrency: {
    maxOpenContinuationsPerSession: 1,  // Single-flight default
  }
};
```

## Implementation Roadmap

### Phase 0: Foundations (0.5 sprint)
- [ ] ULID generator
- [ ] StepLog NDJSON writer
- [ ] ArtifactStore implementation
- [ ] File layout under `/data`
- [ ] Crash recovery scan
- [ ] Shared ToolRegistry

### Phase 1: Session + Continuation MVP (1 sprint)
- [ ] `start_session`, `send_message`, `await_continuation`
- [ ] `end_session`, `cancel`
- [ ] Basic ReAct planner with budgets
- [ ] Rolling summary + lastK memory
- [ ] Persistence and recovery
- [ ] SSE event stream: `/events/{session_id}`

### Phase 2: Resume/Retry + Idempotency (0.5 sprint)
- [ ] Interrupted state handling
- [ ] `resume` and `retry` endpoints
- [ ] Idempotency key deduplication
- [ ] Backpressure: max open continuations

### Phase 3: Safety/Policy + Metrics (0.5 sprint)
- [ ] SessionPolicy allowlists for actuation
- [ ] Token and step usage accounting
- [ ] Secret redaction in logs/artifacts
- [ ] Usage metrics in `get_session`

### Phase 4: Memory Quality (0.5–1 sprint)
- [ ] Fact extraction
- [ ] Pinned context
- [ ] Entity context pinning from indexer
- [ ] Optional: per-session vector memory (bounded)

### Phase 5: UX Polish (0.5 sprint)
- [ ] One-shot `ask` (temp sessions)
- [ ] `list_sessions` for debugging
- [ ] Better error surfaces
- [ ] Cleanup commands

## Example Multi-Turn Flow

### Turn 1: Initial Question

```typescript
// Client
const { session_id } = await mcp.callTool('ha_agent.start_session', {});
const { continuation_id } = await mcp.callTool('ha_agent.send_message', {
  session_id,
  message: "Why did bedroom lights flicker last night?",
  stream: true
});

// Server emits SSE events:
// { type: 'progress', payload: { message: "Gathering related entities" } }
// { type: 'step', payload: { step: { type: 'tool_call', detail: {...} } } }
// { type: 'partial', payload: { partial_response: "Voltage dips detected..." } }
// { type: 'final', payload: { final_response: { finalMessage: "...", citations: [...] } } }

const result = await mcp.callTool('ha_agent.await_continuation', { continuation_id });
// { status: 'completed', response: {...}, artifacts: [{id, path, type}] }
```

### Turn 2: Follow-up

```typescript
const { continuation_id } = await mcp.callTool('ha_agent.send_message', {
  session_id,
  message: "Create a mitigation plan and simulate impact."
});

// Agent reuses session memory (rollingSummary, lastK, facts)
// If long-running, client can:
await mcp.callTool('ha_agent.cancel', { continuation_id, reason: "taking too long" });
```

### Restart Scenario

```typescript
// Server restarts during turn 2
// On startup: continuation_id marked 'interrupted'

// Client can resume:
const result = await mcp.callTool('ha_agent.resume', { continuation_id });
// WAL is replayed, planning continues from last checkpoint
```

## Security Considerations

1. **Actuation Control**
   - Default: `policy.allowActuation = false`
   - Require explicit allowlist: `allowlistedServices: ['switch.turn_off']`

2. **Secret Redaction**
   - Never log HA tokens, API keys
   - Redact sensitive fields in step logs
   - Sanitize artifacts before persistence

3. **Resource Limits**
   - Enforce budgets per continuation
   - Single-flight per session (default)
   - TTL-based cleanup

4. **Authentication**
   - MCP transport already secured via Supervisor token
   - Session isolation (no cross-session access)

## Questions for User

1. **TTL Preferences**: 7 days session / 24h continuation OK?
2. **Actuation**: Start read-only or allow limited actuation?
3. **Model Switching**: Allow per-turn or pin to session?
4. **Concurrency**: Single-flight or allow N open continuations?

## References

- [Zen Chat MCP](https://github.com/zen-browser/zen-mcp) - Continuation pattern inspiration
- [MCP Specification](https://modelcontextprotocol.io/) - Protocol details
- [OpenRouter Streaming](https://openrouter.ai/docs#streaming) - SSE implementation
- [ULID Spec](https://github.com/ulid/spec) - ID generation

---

**Next Steps:**
1. Get user feedback on defaults and open questions
2. Create `/src/agent/` module structure
3. Implement Phase 0 foundations
4. Build Phase 1 MVP with sessions + continuations

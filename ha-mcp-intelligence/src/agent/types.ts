/**
 * Core type definitions for the agent-in-container architecture
 * Based on agent-with-continuations-spec.md
 */

import type { SupervisorClient } from '../server/supervisor-client.js';
import type { BackgroundIndexer } from '../intelligence/background-indexer.js';

// ============================================================================
// Session Types
// ============================================================================

export type SessionStatus = 'active' | 'ended' | 'expired';

export interface AgentSession {
  id: string; // ULID
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  model: ModelConfig;
  budgets: Budgets;
  policy: SessionPolicy;
  memory: SessionMemory;
  messages: TurnMessageMeta[]; // Lightweight refs only
  preferences?: UserPreferences;
  ctx: SessionContext;
  locks: SessionLocks;
  openContinuations: Set<string>;
  stats: SessionStats;
  version: number; // Optimistic concurrency
}

export interface SessionMemory {
  rollingSummary: string; // <2K tokens
  facts: KeyFact[]; // Durable insights
  pins: PinnedContext[]; // Always-include snippets
  lastK: TurnMessage[]; // Last 6 full messages
}

export interface KeyFact {
  id: string;
  fact: string;
  confidence: number; // 0-1
  extractedAt: number;
  relevance: string[]; // Tags for retrieval
}

export interface PinnedContext {
  id: string;
  content: string;
  reason: string;
  pinnedAt: number;
}

export interface TurnMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  continuationId?: string;
}

export interface TurnMessageMeta {
  continuationId: string;
  timestamp: number;
  preview: string; // First 100 chars
}

// ============================================================================
// Continuation Types
// ============================================================================

export type ContinuationStatus =
  | 'pending'
  | 'running'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'interrupted';

export interface Continuation {
  id: string; // ULID
  sessionId: string;
  status: ContinuationStatus;
  createdAt: number;
  updatedAt: number;
  request: ContinuationRequest;
  response?: ContinuationResponse;
  stepLog: StepLogEntry[];
  artifacts?: ArtifactRef[];
  error?: ContinuationError;
}

export interface ContinuationRequest {
  message: string;
  allowTools: boolean;
  maxSteps: number;
  timeBudgetMs: number;
  plannerHints?: PlannerHints;
  idempotencyKey?: string; // Dedupe protection
}

export interface ContinuationResponse {
  finalMessage: string;
  reasoningSummary?: string;
  citations?: Citation[];
  followUps?: string[];
}

export interface ContinuationError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  recoverable: boolean;
}

// ============================================================================
// Step Log Types
// ============================================================================

export type StepLogType =
  | 'plan'
  | 'tool_call'
  | 'tool_result'
  | 'retrieval'
  | 'observed_event'
  | 'summary'
  | 'error';

export interface StepLogEntry {
  ts: number;
  type: StepLogType;
  detail: unknown;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface ModelConfig {
  provider: string; // 'openrouter', 'anthropic', etc.
  modelId: string;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
}

export interface Budgets {
  maxSteps: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxTokensPerTurn: number;
}

export interface SessionPolicy {
  allowActuation: boolean;
  allowlistedServices: string[];
  denylistedServices: string[];
  requireConfirmation: boolean;
  enforceFixedModel: boolean;
}

export interface UserPreferences {
  verbosity?: 'minimal' | 'standard' | 'detailed';
  streamingEnabled?: boolean;
  autoSummarize?: boolean;
}

export interface SessionContext {
  haVersion?: string;
  entityCount?: number;
  lastIndexUpdate?: number;
}

export interface SessionLocks {
  locked: boolean;
  reason?: string;
  lockedAt?: number;
}

export interface SessionStats {
  totalContinuations: number;
  totalSteps: number;
  totalTokensEstimate: number;
  totalToolCalls: number;
  lastActivityAt: number;
}

// ============================================================================
// Tool Registry Types
// ============================================================================

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
  invoke: (args: unknown, ctx: ToolInvokeContext) => Promise<unknown>;
  cost?: ToolCost;
  safety?: ToolSafety;
}

export interface ToolInvokeContext {
  session: AgentSession;
  signal: AbortSignal;
  logger: (e: StepLogEntry) => void;
  haClient: SupervisorClient;
  index: BackgroundIndexer;
  artifacts: ArtifactStore;
}

export interface ToolCost {
  estimatedMs?: number;
  estimatedTokens?: number;
}

export interface ToolSafety {
  requiresActuation: boolean;
  riskLevel: 'safe' | 'low' | 'medium' | 'high';
}

// ============================================================================
// Artifact Types
// ============================================================================

export interface ArtifactRef {
  id: string; // ULID
  type: 'json' | 'text' | 'image' | 'plot' | 'log';
  path: string;
  sizeBytes: number;
  createdAt: number;
  metadata?: Record<string, any>;
}

export interface ArtifactStore {
  write(type: string, content: Buffer | string, metadata?: Record<string, any>): Promise<ArtifactRef>;
  read(id: string): Promise<Buffer>;
  delete(id: string): Promise<void>;
  list(filters?: Record<string, any>): Promise<ArtifactRef[]>;
}

// ============================================================================
// Planner Types
// ============================================================================

export interface PlannerHints {
  focusAreas?: string[];
  avoidTools?: string[];
  preferTools?: string[];
  maxDepth?: number;
}

export interface Citation {
  source: string;
  entityId?: string;
  timestamp?: number;
  excerpt?: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULTS = {
  memory: {
    lastK: 6, // Last 6 full messages
    summaryTokens: 2000, // Rolling summary target
  },
  budgets: {
    maxSteps: 8,
    maxToolCalls: 16,
    maxDurationMs: 120_000, // 2 minutes
    maxTokensPerTurn: 100_000,
  },
  ttl: {
    sessionIdleDays: 7,
    continuationRetentionHours: 24,
  },
  streaming: {
    partialUpdateIntervalMs: 500, // Coalesced chunks
    flushCadenceMs: 2000, // Persistence
  },
  concurrency: {
    maxOpenContinuationsPerSession: 1, // Single-flight default
  },
  policy: {
    allowActuation: false, // Read-only by default
    allowlistedServices: [] as string[],
    denylistedServices: [] as string[],
    requireConfirmation: true,
    enforceFixedModel: false,
  },
} as const;

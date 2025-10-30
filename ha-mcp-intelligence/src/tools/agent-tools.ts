/**
 * Agent Tools - MCP tools for agent session management
 * Implements ha_agent.* tools from the specification
 */

import { SessionManager } from '../agent/session-manager.js';
import { ContinuationRunner } from '../agent/continuation-runner.js';
import type { ModelConfig, Budgets, SessionPolicy, UserPreferences } from '../agent/types.js';

export interface AgentToolsConfig {
  sessionManager: SessionManager;
  continuationRunner: ContinuationRunner;
}

export class AgentTools {
  private sessionManager: SessionManager;
  private continuationRunner: ContinuationRunner;

  constructor(config: AgentToolsConfig) {
    this.sessionManager = config.sessionManager;
    this.continuationRunner = config.continuationRunner;
  }

  /**
   * MCP Tool: ha_agent.start_session
   * Start a new long-lived session
   */
  async startSession(args: {
    model?: ModelConfig;
    budgets?: Budgets;
    policy?: SessionPolicy;
    preferences?: UserPreferences;
  }): Promise<{ session_id: string }> {
    const session = await this.sessionManager.createSession({
      model: args.model,
      budgets: args.budgets,
      policy: args.policy,
      preferences: args.preferences,
    });

    return { session_id: session.id };
  }

  /**
   * MCP Tool: ha_agent.send_message
   * Send a message in a session (creates continuation)
   */
  async sendMessage(args: {
    session_id: string;
    message: string;
    allow_tools?: boolean;
    max_steps?: number;
    time_budget_ms?: number;
    idempotency_key?: string;
  }): Promise<{ continuation_id: string; acknowledged: boolean }> {
    const session = this.sessionManager.getSession(args.session_id);
    if (!session) {
      throw new Error(`Session ${args.session_id} not found`);
    }

    // Create continuation
    const continuation = await this.continuationRunner.createContinuation(session, {
      message: args.message,
      allowTools: args.allow_tools ?? true,
      maxSteps: args.max_steps ?? session.budgets.maxSteps,
      timeBudgetMs: args.time_budget_ms ?? session.budgets.maxDurationMs,
      idempotencyKey: args.idempotency_key,
    });

    // Add to session
    await this.sessionManager.addContinuation(session.id, continuation.id);

    // Start execution in background (non-blocking)
    this.continuationRunner.execute(session, continuation).catch((err) => {
      console.error(`Continuation ${continuation.id} failed:`, err);
    });

    return {
      continuation_id: continuation.id,
      acknowledged: true,
    };
  }

  /**
   * MCP Tool: ha_agent.await_continuation
   * Wait for continuation to complete
   */
  async awaitContinuation(args: {
    continuation_id: string;
    session_id: string;
    timeout_ms?: number;
  }): Promise<{
    status: string;
    response?: unknown;
    artifacts?: unknown[];
  }> {
    const continuation = await this.continuationRunner.await(
      args.session_id,
      args.continuation_id,
      args.timeout_ms
    );

    // Remove from session's open continuations
    await this.sessionManager.removeContinuation(args.session_id, continuation.id);

    // Add message to session memory
    if (continuation.response) {
      await this.sessionManager.addMessage(
        args.session_id,
        {
          role: 'assistant',
          content: continuation.response.finalMessage,
          timestamp: continuation.updatedAt,
          continuationId: continuation.id,
        },
        {
          continuationId: continuation.id,
          timestamp: continuation.updatedAt,
          preview: continuation.response.finalMessage.substring(0, 100),
        }
      );
    }

    return {
      status: continuation.status,
      response: continuation.response,
      artifacts: continuation.artifacts,
    };
  }

  /**
   * MCP Tool: ha_agent.cancel
   * Cancel a running continuation
   */
  async cancel(args: {
    continuation_id: string;
    reason?: string;
  }): Promise<{ status: string }> {
    const cancelled = await this.continuationRunner.cancel(args.continuation_id, args.reason);

    if (!cancelled) {
      return { status: 'not_found' };
    }

    return { status: 'cancelled' };
  }

  /**
   * MCP Tool: ha_agent.get_session
   * Get session state
   */
  async getSession(args: { session_id: string }): Promise<{ session: unknown }> {
    const session = this.sessionManager.getSession(args.session_id);
    if (!session) {
      throw new Error(`Session ${args.session_id} not found`);
    }

    // Return a summary (not full session with all internals)
    return {
      session: {
        id: session.id,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        stats: session.stats,
        memorySize: {
          rollingSummaryLength: session.memory.rollingSummary.length,
          factsCount: session.memory.facts.length,
          lastKCount: session.memory.lastK.length,
        },
      },
    };
  }

  /**
   * MCP Tool: ha_agent.end_session
   * End a session
   */
  async endSession(args: {
    session_id: string;
    reason?: string;
  }): Promise<{ status: string }> {
    await this.sessionManager.endSession(args.session_id, args.reason);
    return { status: 'ended' };
  }

  /**
   * MCP Tool: ha_agent.list_sessions
   * List active sessions (for debugging)
   */
  async listSessions(args?: {
    status?: 'active' | 'expired';
    limit?: number;
  }): Promise<{ sessions: unknown[] }> {
    const sessions = this.sessionManager.listSessions(args?.status);
    const limit = args?.limit || 10;

    return {
      sessions: sessions.slice(0, limit).map((s) => ({
        id: s.id,
        status: s.status,
        createdAt: s.createdAt,
        stats: s.stats,
      })),
    };
  }

  /**
   * MCP Tool: ha_agent.ask (one-shot)
   * Simplified one-shot interface (creates temp session)
   */
  async ask(args: {
    message: string;
    model?: ModelConfig;
    budgets?: Budgets;
    allow_tools?: boolean;
  }): Promise<{
    response: unknown;
    artifacts?: unknown[];
  }> {
    // Create temporary session
    const session = await this.sessionManager.createSession({
      model: args.model,
      budgets: args.budgets,
    });

    try {
      // Send message and wait
      const { continuation_id } = await this.sendMessage({
        session_id: session.id,
        message: args.message,
        allow_tools: args.allow_tools,
      });

      const result = await this.awaitContinuation({
        session_id: session.id,
        continuation_id,
      });

      return {
        response: result.response,
        artifacts: result.artifacts,
      };
    } finally {
      // Clean up temp session
      await this.sessionManager.endSession(session.id, 'one-shot_completed');
    }
  }
}

/**
 * SessionManager - Manages agent sessions with memory and persistence
 */

import { ulid } from './ulid.js';
import { FileLayout } from './file-layout.js';
import type {
  AgentSession,
  SessionMemory,
  SessionStatus,
  ModelConfig,
  Budgets,
  SessionPolicy,
  UserPreferences,
  TurnMessage,
  TurnMessageMeta,
} from './types.js';

import { DEFAULTS } from './types.js';

const defaults = DEFAULTS;

export interface SessionManagerConfig {
  dataPath: string;
  defaultModel: ModelConfig;
  defaultBudgets?: Budgets;
  defaultPolicy?: SessionPolicy;
}

export class SessionManager {
  private fileLayout: FileLayout;
  private sessions = new Map<string, AgentSession>();
  private defaultModel: ModelConfig;
  private defaultBudgets: Budgets;
  private defaultPolicy: SessionPolicy;

  constructor(config: SessionManagerConfig) {
    this.fileLayout = new FileLayout(config.dataPath);
    this.defaultModel = config.defaultModel;
    this.defaultBudgets = config.defaultBudgets || defaults.budgets;
    this.defaultPolicy = config.defaultPolicy || defaults.policy;
  }

  /**
   * Initialize the session manager
   */
  async init(): Promise<void> {
    await this.fileLayout.init();
    await this.loadExistingSessions();
  }

  /**
   * Load existing sessions from disk (crash recovery)
   */
  private async loadExistingSessions(): Promise<void> {
    const sessionIds = await this.fileLayout.listSessions();

    for (const sessionId of sessionIds) {
      const session = await this.fileLayout.readSession(sessionId);
      if (session) {
        // Mark any running/streaming/pending continuations as interrupted
        if (session.openContinuations.size > 0) {
          session.status = 'active'; // Keep session active
          // Note: Continuation status updates would happen in ContinuationRunner
        }

        this.sessions.set(sessionId, session);
      }
    }
  }

  /**
   * Create a new session
   */
  async createSession(options?: {
    model?: ModelConfig;
    budgets?: Budgets;
    policy?: SessionPolicy;
    preferences?: UserPreferences;
  }): Promise<AgentSession> {
    const sessionId = ulid();
    const now = Date.now();

    const session: AgentSession = {
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      model: options?.model || this.defaultModel,
      budgets: options?.budgets || this.defaultBudgets,
      policy: options?.policy || this.defaultPolicy,
      memory: this.createEmptyMemory(),
      messages: [],
      preferences: options?.preferences,
      ctx: {},
      locks: { locked: false },
      openContinuations: new Set(),
      stats: {
        totalContinuations: 0,
        totalSteps: 0,
        totalTokensEstimate: 0,
        totalToolCalls: 0,
        lastActivityAt: now,
      },
      version: 1,
    };

    this.sessions.set(sessionId, session);
    await this.persist(session);

    return session;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Update session (with optimistic concurrency)
   */
  async updateSession(session: AgentSession): Promise<void> {
    const existing = this.sessions.get(session.id);
    if (!existing) {
      throw new Error(`Session ${session.id} not found`);
    }

    if (existing.version !== session.version) {
      throw new Error(`Session ${session.id} version mismatch (optimistic lock failed)`);
    }

    session.version += 1;
    session.updatedAt = Date.now();

    this.sessions.set(session.id, session);
    await this.persist(session);
  }

  /**
   * End a session
   */
  async endSession(sessionId: string, reason?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.status = 'ended';
    session.updatedAt = Date.now();

    await this.updateSession(session);
  }

  /**
   * Add a message to session memory
   */
  async addMessage(
    sessionId: string,
    message: TurnMessage,
    meta: TurnMessageMeta
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Add to lastK (ring buffer)
    session.memory.lastK.push(message);
    if (session.memory.lastK.length > defaults.memory.lastK) {
      session.memory.lastK.shift(); // Remove oldest
    }

    // Add metadata reference
    session.messages.push(meta);

    // Update stats
    session.stats.lastActivityAt = Date.now();

    await this.updateSession(session);
  }

  /**
   * Update rolling summary
   */
  async updateSummary(sessionId: string, summary: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.memory.rollingSummary = summary;
    await this.updateSession(session);
  }

  /**
   * Add a continuation to session
   */
  async addContinuation(sessionId: string, continuationId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.openContinuations.add(continuationId);
    session.stats.totalContinuations += 1;

    await this.updateSession(session);
  }

  /**
   * Remove a continuation from session
   */
  async removeContinuation(sessionId: string, continuationId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.openContinuations.delete(continuationId);
    await this.updateSession(session);
  }

  /**
   * List all active sessions
   */
  listSessions(status?: SessionStatus): AgentSession[] {
    const sessions = Array.from(this.sessions.values());

    if (status) {
      return sessions.filter((s) => s.status === status);
    }

    return sessions;
  }

  /**
   * Cleanup expired sessions
   */
  async cleanup(): Promise<number> {
    const now = Date.now();
    const idleCutoff = now - defaults.ttl.sessionIdleDays * 24 * 60 * 60 * 1000;

    let cleaned = 0;
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.status === 'active' && session.stats.lastActivityAt < idleCutoff) {
        session.status = 'expired';
        await this.updateSession(session);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Persist session to disk
   */
  private async persist(session: AgentSession): Promise<void> {
    await this.fileLayout.writeSession(session);
  }

  /**
   * Create empty memory structure
   */
  private createEmptyMemory(): SessionMemory {
    return {
      rollingSummary: '',
      facts: [],
      pins: [],
      lastK: [],
    };
  }
}

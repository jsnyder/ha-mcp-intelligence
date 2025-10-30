/**
 * ContinuationRunner - Executes continuations with ReAct planning
 */

import { ulid } from './ulid.js';
import { StepLogger } from './step-logger.js';
import { ArtifactStore } from './artifact-store.js';
import { FileLayout } from './file-layout.js';
import { ToolRegistry } from './tool-registry.js';
import type {
  Continuation,
  ContinuationRequest,
  ContinuationResponse,
  ContinuationStatus,
  AgentSession,
  StepLogEntry,
  ToolInvokeContext,
} from './types.js';
import type { SupervisorClient } from '../server/supervisor-client.js';
import type { BackgroundIndexer } from '../intelligence/background-indexer.js';

export interface ContinuationRunnerConfig {
  dataPath: string;
  fileLayout: FileLayout;
  toolRegistry: ToolRegistry;
  artifactStore: ArtifactStore;
  haClient: SupervisorClient;
  indexer: BackgroundIndexer;
}

export class ContinuationRunner {
  private fileLayout: FileLayout;
  private toolRegistry: ToolRegistry;
  private artifactStore: ArtifactStore;
  private haClient: SupervisorClient;
  private indexer: BackgroundIndexer;
  private activeContinuations = new Map<string, Continuation>();
  private abortControllers = new Map<string, AbortController>();

  constructor(config: ContinuationRunnerConfig) {
    this.fileLayout = config.fileLayout;
    this.toolRegistry = config.toolRegistry;
    this.artifactStore = config.artifactStore;
    this.haClient = config.haClient;
    this.indexer = config.indexer;
  }

  /**
   * Create a new continuation
   */
  async createContinuation(
    session: AgentSession,
    request: ContinuationRequest
  ): Promise<Continuation> {
    const continuationId = ulid();
    const now = Date.now();

    const continuation: Continuation = {
      id: continuationId,
      sessionId: session.id,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      request,
      stepLog: [],
    };

    this.activeContinuations.set(continuationId, continuation);
    await this.fileLayout.writeContinuation(session.id, continuation);

    return continuation;
  }

  /**
   * Execute a continuation
   */
  async execute(session: AgentSession, continuation: Continuation): Promise<void> {
    const abortController = new AbortController();
    this.abortControllers.set(continuation.id, abortController);

    try {
      // Update status to running
      continuation.status = 'running';
      continuation.updatedAt = Date.now();
      await this.fileLayout.writeContinuation(session.id, continuation);

      // Initialize step logger
      const logPath = this.fileLayout.getLogFile(session.id, continuation.id);
      const stepLogger = new StepLogger({
        logPath,
        autoFlush: true,
        flushIntervalMs: 2000,
      });

      await stepLogger.start();

      // Create tool invoke context
      const toolCtx: ToolInvokeContext = {
        session,
        signal: abortController.signal,
        logger: (entry: StepLogEntry) => {
          continuation.stepLog.push(entry);
          stepLogger.log(entry);
        },
        haClient: this.haClient,
        index: this.indexer,
        artifacts: this.artifactStore,
      };

      // Log start
      toolCtx.logger({
        ts: Date.now(),
        type: 'plan',
        detail: { message: 'Starting continuation execution' },
      });

      // TODO: Implement actual ReAct loop with LLM
      // For MVP, we'll create a simple stub response
      const response = await this.runSimplePlanner(continuation.request, toolCtx);

      // Update continuation with response
      continuation.response = response;
      continuation.status = 'completed';
      continuation.updatedAt = Date.now();

      await stepLogger.close();
      await this.fileLayout.writeContinuation(session.id, continuation);
    } catch (err) {
      continuation.status = 'failed';
      continuation.error = {
        code: 'EXECUTION_ERROR',
        message: (err as Error).message,
        details: { stack: (err as Error).stack },
        recoverable: false,
      };
      continuation.updatedAt = Date.now();
      await this.fileLayout.writeContinuation(session.id, continuation);

      throw err;
    } finally {
      this.abortControllers.delete(continuation.id);
      this.activeContinuations.delete(continuation.id);
    }
  }

  /**
   * Simple planner stub (will be replaced with actual LLM-based ReAct loop)
   */
  private async runSimplePlanner(
    request: ContinuationRequest,
    ctx: ToolInvokeContext
  ): Promise<ContinuationResponse> {
    // Log the request
    ctx.logger({
      ts: Date.now(),
      type: 'plan',
      detail: { phase: 'analyzing_request', message: request.message },
    });

    // For MVP, return a simple acknowledgment
    // TODO: Implement actual LLM call with ReAct prompting
    const response: ContinuationResponse = {
      finalMessage: `I received your message: "${request.message}". This is a stub response. Full LLM integration coming in next iteration.`,
      reasoningSummary: 'Stub planner - no actual reasoning performed yet',
      followUps: ['Implement actual LLM integration', 'Add ReAct loop', 'Add tool selection'],
    };

    ctx.logger({
      ts: Date.now(),
      type: 'summary',
      detail: { response },
    });

    return response;
  }

  /**
   * Cancel a running continuation
   */
  async cancel(continuationId: string, reason?: string): Promise<boolean> {
    const abortController = this.abortControllers.get(continuationId);
    if (!abortController) {
      return false; // Not running
    }

    abortController.abort();

    const continuation = this.activeContinuations.get(continuationId);
    if (continuation) {
      continuation.status = 'cancelled';
      continuation.error = {
        code: 'CANCELLED',
        message: reason || 'Continuation cancelled by user',
        recoverable: false,
      };
      continuation.updatedAt = Date.now();

      await this.fileLayout.writeContinuation(continuation.sessionId, continuation);
    }

    return true;
  }

  /**
   * Get continuation by ID
   */
  async getContinuation(sessionId: string, continuationId: string): Promise<Continuation | null> {
    // Check active first
    const active = this.activeContinuations.get(continuationId);
    if (active) {
      return active;
    }

    // Load from disk
    return await this.fileLayout.readContinuation(sessionId, continuationId);
  }

  /**
   * Wait for continuation to complete
   */
  async await(sessionId: string, continuationId: string, timeoutMs = 60000): Promise<Continuation> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const continuation = await this.getContinuation(sessionId, continuationId);
      if (!continuation) {
        throw new Error(`Continuation ${continuationId} not found`);
      }

      if (this.isFinalStatus(continuation.status)) {
        return continuation;
      }

      // Poll every 500ms
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Continuation ${continuationId} timed out after ${timeoutMs}ms`);
  }

  /**
   * Check if status is final (completed/failed/cancelled)
   */
  private isFinalStatus(status: ContinuationStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
  }
}

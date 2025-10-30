/**
 * File layout manager for agent persistence
 *
 * Structure:
 * /data/
 * ├── sessions/{sessionId}/
 * │   ├── session.json
 * │   ├── turns/{contId}.json
 * │   └── logs/{contId}.log
 * ├── artifacts/{artifactId}
 * └── index/meta.json
 */

import { join } from 'path';
import { mkdir, readFile, writeFile, readdir } from 'fs/promises';
import type { AgentSession, Continuation } from './types.js';

export class FileLayout {
  private dataPath: string;

  constructor(dataPath: string) {
    this.dataPath = dataPath;
  }

  /**
   * Initialize the file layout
   */
  async init(): Promise<void> {
    await mkdir(this.dataPath, { recursive: true });
    await mkdir(this.getSessionsPath(), { recursive: true });
    await mkdir(this.getArtifactsPath(), { recursive: true });
    await mkdir(this.getIndexPath(), { recursive: true });
  }

  // Path helpers
  getSessionsPath(): string {
    return join(this.dataPath, 'sessions');
  }

  getSessionPath(sessionId: string): string {
    return join(this.getSessionsPath(), sessionId);
  }

  getSessionFile(sessionId: string): string {
    return join(this.getSessionPath(sessionId), 'session.json');
  }

  getTurnsPath(sessionId: string): string {
    return join(this.getSessionPath(sessionId), 'turns');
  }

  getTurnFile(sessionId: string, continuationId: string): string {
    return join(this.getTurnsPath(sessionId), `${continuationId}.json`);
  }

  getLogsPath(sessionId: string): string {
    return join(this.getSessionPath(sessionId), 'logs');
  }

  getLogFile(sessionId: string, continuationId: string): string {
    return join(this.getLogsPath(sessionId), `${continuationId}.log`);
  }

  getArtifactsPath(): string {
    return join(this.dataPath, 'artifacts');
  }

  getIndexPath(): string {
    return join(this.dataPath, 'index');
  }

  /**
   * Write session metadata
   */
  async writeSession(session: AgentSession): Promise<void> {
    const sessionPath = this.getSessionPath(session.id);
    await mkdir(sessionPath, { recursive: true });
    await mkdir(this.getTurnsPath(session.id), { recursive: true });
    await mkdir(this.getLogsPath(session.id), { recursive: true });

    // Convert Set to Array for JSON serialization
    const serializable = {
      ...session,
      openContinuations: Array.from(session.openContinuations),
    };

    await writeFile(this.getSessionFile(session.id), JSON.stringify(serializable, null, 2), 'utf8');
  }

  /**
   * Read session metadata
   */
  async readSession(sessionId: string): Promise<AgentSession | null> {
    try {
      const content = await readFile(this.getSessionFile(sessionId), 'utf8');
      const data = JSON.parse(content);

      // Convert Array back to Set
      return {
        ...data,
        openContinuations: new Set(data.openContinuations),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Write continuation record
   */
  async writeContinuation(sessionId: string, continuation: Continuation): Promise<void> {
    const turnsPath = this.getTurnsPath(sessionId);
    await mkdir(turnsPath, { recursive: true });

    await writeFile(
      this.getTurnFile(sessionId, continuation.id),
      JSON.stringify(continuation, null, 2),
      'utf8'
    );
  }

  /**
   * Read continuation record
   */
  async readContinuation(sessionId: string, continuationId: string): Promise<Continuation | null> {
    try {
      const content = await readFile(this.getTurnFile(sessionId, continuationId), 'utf8');
      return JSON.parse(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * List all session IDs
   */
  async listSessions(): Promise<string[]> {
    try {
      return await readdir(this.getSessionsPath());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /**
   * List all continuations for a session
   */
  async listContinuations(sessionId: string): Promise<string[]> {
    try {
      const files = await readdir(this.getTurnsPath(sessionId));
      return files.map((f) => f.replace('.json', ''));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }
}

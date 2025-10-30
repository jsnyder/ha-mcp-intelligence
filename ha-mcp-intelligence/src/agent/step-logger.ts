/**
 * StepLogger - NDJSON (Newline-Delimited JSON) writer for step logs
 * Implements Write-Ahead Log (WAL) pattern for crash recovery
 */

import { createWriteStream, WriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { StepLogEntry } from './types.js';

export interface StepLoggerConfig {
  logPath: string;
  autoFlush: boolean;
  flushIntervalMs?: number;
  bufferSize?: number;
}

export class StepLogger {
  private logPath: string;
  private stream: WriteStream | null = null;
  private buffer: StepLogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushIntervalMs: number;
  private bufferSize: number;
  private autoFlush: boolean;
  private closed = false;

  constructor(config: StepLoggerConfig) {
    this.logPath = config.logPath;
    this.autoFlush = config.autoFlush;
    this.flushIntervalMs = config.flushIntervalMs || 2000; // 2 seconds default
    this.bufferSize = config.bufferSize || 5; // 5 entries default
  }

  /**
   * Initialize the logger and create write stream
   */
  async start(): Promise<void> {
    // Ensure directory exists
    const dir = dirname(this.logPath);
    await mkdir(dir, { recursive: true });

    // Create append stream
    this.stream = createWriteStream(this.logPath, {
      flags: 'a', // Append mode
      encoding: 'utf8',
    });

    // Setup auto-flush if enabled
    if (this.autoFlush && this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((err) => {
          console.error('StepLogger auto-flush error:', err);
        });
      }, this.flushIntervalMs);
    }
  }

  /**
   * Log a step entry (buffered)
   */
  log(entry: StepLogEntry): void {
    if (this.closed) {
      throw new Error('StepLogger is closed');
    }

    this.buffer.push(entry);

    // Auto-flush if buffer full
    if (this.buffer.length >= this.bufferSize) {
      this.flush().catch((err) => {
        console.error('StepLogger flush error:', err);
      });
    }
  }

  /**
   * Flush buffered entries to disk
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.stream) {
      return;
    }

    const entries = this.buffer.splice(0); // Drain buffer

    return new Promise((resolve, reject) => {
      if (!this.stream) {
        reject(new Error('Stream not initialized'));
        return;
      }

      // Write each entry as NDJSON (one JSON object per line)
      const lines = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';

      this.stream.write(lines, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Close the logger and flush remaining entries
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    // Clear flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush remaining entries
    await this.flush();

    // Close stream
    return new Promise((resolve, reject) => {
      if (!this.stream) {
        resolve();
        return;
      }

      this.stream.end((err?: Error) => {
        if (err) {
          reject(err);
        } else {
          this.stream = null;
          resolve();
        }
      });
    });
  }

  /**
   * Read all entries from a log file
   */
  static async readLog(logPath: string): Promise<StepLogEntry[]> {
    const fs = await import('fs/promises');

    try {
      const content = await fs.readFile(logPath, 'utf8');
      const lines = content.trim().split('\n');

      return lines
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as StepLogEntry);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []; // File doesn't exist yet
      }
      throw err;
    }
  }

  /**
   * Replay log entries (for crash recovery)
   */
  static async* replayLog(logPath: string): AsyncGenerator<StepLogEntry> {
    const entries = await StepLogger.readLog(logPath);

    for (const entry of entries) {
      yield entry;
    }
  }
}

/**
 * ArtifactStore - Storage for large results, plots, logs, and other artifacts
 */

import { writeFile, readFile, unlink, readdir, stat } from 'fs/promises';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { ulid } from './ulid.js';
import type { ArtifactRef, ArtifactStore as IArtifactStore } from './types.js';

export class ArtifactStore implements IArtifactStore {
  private basePath: string;
  private maxSizeMB: number;

  constructor(basePath: string, maxSizeMB = 100) {
    this.basePath = basePath;
    this.maxSizeMB = maxSizeMB;
  }

  /**
   * Initialize the artifact store
   */
  async init(): Promise<void> {
    await mkdir(this.basePath, { recursive: true });
  }

  /**
   * Write an artifact to storage
   */
  async write(
    type: string,
    content: Buffer | string,
    metadata?: Record<string, unknown>
  ): Promise<ArtifactRef> {
    const id = ulid();
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;

    // Check size limit
    const sizeMB = buffer.length / (1024 * 1024);
    if (sizeMB > this.maxSizeMB) {
      throw new Error(
        `Artifact size ${sizeMB.toFixed(2)}MB exceeds limit of ${this.maxSizeMB}MB`
      );
    }

    const path = join(this.basePath, id);
    await writeFile(path, buffer);

    const ref: ArtifactRef = {
      id,
      type: type as ArtifactRef['type'],
      path,
      sizeBytes: buffer.length,
      createdAt: Date.now(),
      metadata,
    };

    return ref;
  }

  /**
   * Read an artifact from storage
   */
  async read(id: string): Promise<Buffer> {
    const path = join(this.basePath, id);

    try {
      return await readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Artifact not found: ${id}`);
      }
      throw err;
    }
  }

  /**
   * Delete an artifact
   */
  async delete(id: string): Promise<void> {
    const path = join(this.basePath, id);

    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Already deleted, not an error
        return;
      }
      throw err;
    }
  }

  /**
   * List artifacts with optional filters
   */
  async list(filters?: Record<string, unknown>): Promise<ArtifactRef[]> {
    const files = await readdir(this.basePath);
    const refs: ArtifactRef[] = [];

    for (const file of files) {
      const path = join(this.basePath, file);
      const stats = await stat(path);

      // Basic ref (no metadata filtering yet)
      const ref: ArtifactRef = {
        id: file,
        type: 'text', // Would need metadata file to track type
        path,
        sizeBytes: stats.size,
        createdAt: stats.ctimeMs,
      };

      refs.push(ref);
    }

    // Apply filters if provided
    if (filters) {
      return refs.filter((ref) => {
        if (filters.type && ref.type !== filters.type) {
          return false;
        }
        if (filters.minSize && ref.sizeBytes < (filters.minSize as number)) {
          return false;
        }
        if (filters.maxSize && ref.sizeBytes > (filters.maxSize as number)) {
          return false;
        }
        return true;
      });
    }

    return refs;
  }

  /**
   * Get total storage used
   */
  async getStorageStats(): Promise<{ totalBytes: number; fileCount: number }> {
    const refs = await this.list();
    const totalBytes = refs.reduce((sum, ref) => sum + ref.sizeBytes, 0);

    return {
      totalBytes,
      fileCount: refs.length,
    };
  }

  /**
   * Cleanup old artifacts (older than N days)
   */
  async cleanup(olderThanDays: number): Promise<number> {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const refs = await this.list();

    let deleted = 0;
    for (const ref of refs) {
      if (ref.createdAt < cutoff) {
        await this.delete(ref.id);
        deleted++;
      }
    }

    return deleted;
  }
}

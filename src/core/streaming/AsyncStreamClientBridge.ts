/**
 * @fileoverview Push-to-pull streaming adapter for AgentOS responses.
 *
 * Bridges the push-based StreamingManager to a pull-based AsyncGenerator
 * consumable by AgentOS.processRequest and similar facades.
 */

import type { IStreamClient, StreamClientId } from './IStreamClient';
import type { AgentOSResponse } from '../../api/types/AgentOSResponse';
import { uuidv4 } from '../utils/uuid.js';

/**
 * Acts as an IStreamClient to bridge push-based data flow from StreamingManager
 * to a pull-based AsyncGenerator. Queues incoming chunks and uses promises to
 * signal availability to a consuming async generator loop.
 */
export class AsyncStreamClientBridge implements IStreamClient {
  public readonly id: StreamClientId;

  private readonly chunkQueue: AgentOSResponse[] = [];
  private resolveNextChunkPromise: ((value: IteratorResult<AgentOSResponse, void>) => void) | null = null;
  private rejectNextChunkPromise: ((reason?: any) => void) | null = null;
  private streamClosed: boolean = false;
  private processingError: Error | null = null;

  constructor(debugIdPrefix: string = 'bridge-client') {
    this.id = `${debugIdPrefix}-${uuidv4()}` as StreamClientId;
  }

  public async sendChunk(chunk: AgentOSResponse): Promise<void> {
    if (this.streamClosed) {
      console.warn(`AsyncStreamClientBridge (${this.id}): Received chunk on already closed stream. Chunk ignored.`, chunk.type);
      return;
    }

    this.chunkQueue.push(chunk);

    if (this.resolveNextChunkPromise) {
      const resolve = this.resolveNextChunkPromise;
      this.resolveNextChunkPromise = null;
      this.rejectNextChunkPromise = null;
      resolve({ value: this.chunkQueue.shift()!, done: false });
    }
  }

  public async notifyStreamClosed(reason?: string): Promise<void> {
    if (this.streamClosed) return;

    console.log(`AsyncStreamClientBridge (${this.id}): Stream closed. Reason: ${reason || 'N/A'}`);
    this.streamClosed = true;
    if (this.resolveNextChunkPromise) {
      const resolve = this.resolveNextChunkPromise;
      this.resolveNextChunkPromise = null;
      this.rejectNextChunkPromise = null;
      resolve({ value: undefined, done: true });
    }
  }

  public forceClose(): void {
    if (!this.streamClosed) {
      this.streamClosed = true;
      if (this.resolveNextChunkPromise) {
        const resolve = this.resolveNextChunkPromise;
        this.resolveNextChunkPromise = null;
        this.rejectNextChunkPromise = null;
        resolve({ value: undefined, done: true });
      }
    }
  }

  public isActive(): boolean {
    return !this.streamClosed;
  }

  public async close(reason?: string): Promise<void> {
    console.log(`AsyncStreamClientBridge (${this.id}): Explicitly closed. Reason: ${reason || 'N/A'}`);
    this.forceClose();
  }

  public async *consume(): AsyncGenerator<AgentOSResponse, void, undefined> {
    try {
      while (true) {
        if (this.chunkQueue.length > 0) {
          yield this.chunkQueue.shift()!;
          continue;
        }

        if (this.streamClosed) {
          break;
        }

        if (this.processingError) {
          const errToThrow = this.processingError;
          this.processingError = null;
          throw errToThrow;
        }

        const result = await new Promise<IteratorResult<AgentOSResponse, void>>((resolve, reject) => {
          this.resolveNextChunkPromise = resolve;
          this.rejectNextChunkPromise = reject;
          if (this.chunkQueue.length > 0) {
            if (this.resolveNextChunkPromise) this.resolveNextChunkPromise({ value: this.chunkQueue.shift()!, done: false });
            this.resolveNextChunkPromise = null; this.rejectNextChunkPromise = null;
          } else if (this.streamClosed) {
            if (this.resolveNextChunkPromise) this.resolveNextChunkPromise({ value: undefined, done: true });
            this.resolveNextChunkPromise = null; this.rejectNextChunkPromise = null;
          } else if (this.processingError) {
            if (this.rejectNextChunkPromise) this.rejectNextChunkPromise(this.processingError);
            this.processingError = null; this.resolveNextChunkPromise = null; this.rejectNextChunkPromise = null;
          }
        });

        if (result.done) {
          break;
        }
        const nextChunk = result.value as AgentOSResponse;
        if (!nextChunk) {
          continue;
        }
        yield nextChunk;
      }
    } catch (error) {
      console.error(`AsyncStreamClientBridge (${this.id}): Error during consumption loop.`, error);
      this.streamClosed = true;
      if (this.resolveNextChunkPromise) {
        this.resolveNextChunkPromise({ value: undefined, done: true });
        this.resolveNextChunkPromise = null;
        this.rejectNextChunkPromise = null;
      }
      throw error;
    } finally {
      this.resolveNextChunkPromise = null;
      this.rejectNextChunkPromise = null;
      this.streamClosed = true;
    }
  }
}

// File: src/core/streaming/StreamingManager.ts
/**
 * @fileoverview Implements the StreamingManager, a core component responsible for
 * managing real-time data streams within AgentOS. It handles the lifecycle of streams,
 * registration of clients to streams, and distribution of data chunks to subscribed clients.
 * This manager is designed for robustness, scalability (conceptual), and clear error handling.
 *
 * @module backend/core/streaming/StreamingManager
 * @see ./IStreamClient.ts For the client contract.
 * @see ../../api/types/AgentOSResponse.ts For the data chunk structure.
 */

import { uuidv4 } from '../utils/uuid';
import { AgentOSResponse, AgentOSErrorChunk, AgentOSResponseChunkType } from '../../api/types/AgentOSResponse';
import { IStreamClient, StreamClientId } from './IStreamClient';
import { GMIError, GMIErrorCode } from '../utils/errors.js'; // Corrected path

/**
 * Represents a unique identifier for a data stream.
 * @typedef {string} StreamId
 */
export type StreamId = string;

/**
 * Configuration options for the StreamingManager.
 * @interface StreamingManagerConfig
 */
export interface StreamingManagerConfig {
  /**
   * Maximum number of concurrent active streams allowed.
   * If set to 0 or a negative number, it implies no limit (not recommended for production).
   * @type {number}
   * @default 1000
   */
  maxConcurrentStreams?: number;

  /**
   * Default timeout in milliseconds for a stream if no activity is detected.
   * If set to 0, streams do not time out automatically. (Conceptual, requires active tracking)
   * @type {number}
   * @default 300000 (5 minutes)
   */
  defaultStreamInactivityTimeoutMs?: number;

  /**
   * Maximum number of clients allowed to subscribe to a single stream.
   * If set to 0 or a negative number, it implies no limit.
   * @type {number}
   * @default 10
   */
  maxClientsPerStream?: number;

  /**
   * Optional: Defines the behavior when trying to push a chunk to a client whose `sendChunk` method fails.
   * - 'log_and_continue': Logs the error and continues sending to other clients. (Default)
   * - 'deregister_client': Logs the error, attempts to deregister the failing client, and continues.
   * - 'throw': Throws an error, potentially stopping the push operation for the current chunk to other clients.
   * @type {'log_and_continue' | 'deregister_client' | 'throw'}
   * @default 'log_and_continue'
   */
  onClientSendErrorBehavior?: 'log_and_continue' | 'deregister_client' | 'throw';
}

/**
 * Custom error class for errors originating from the StreamingManager.
 * @class StreamError
 * @extends {GMIError}
 */
export class StreamError extends GMIError {
  /**
   * The ID of the stream involved in the error, if applicable.
   * @public
   * @readonly
   * @type {StreamId | undefined}
   */
  public readonly streamId?: StreamId;

  /**
   * The ID of the client involved in the error, if applicable.
   * @public
   * @readonly
   * @type {StreamClientId | undefined}
   */
  public readonly clientId?: StreamClientId;

  /**
   * Creates an instance of StreamError.
   * @param {string} message - The human-readable error message.
   * @param {GMIErrorCode | string} code - A specific error code (can be from GMIErrorCode or custom).
   * @param {StreamId} [streamId] - The ID of the stream involved.
   * @param {StreamClientId} [clientId] - The ID of the client involved.
   * @param {any} [details] - Optional additional context or the underlying error.
   */
  constructor(
    message: string,
    code: GMIErrorCode | string,
    streamId?: StreamId,
    clientId?: StreamClientId,
    details?: any,
  ) {
    super(message, code as GMIErrorCode, details);
    this.name = 'StreamError'; // This is standard for custom errors extending Error
    this.streamId = streamId;
    this.clientId = clientId;
    Object.setPrototypeOf(this, StreamError.prototype);
  }
}

/**
 * @interface IStreamingManager
 * @description Defines the contract for the StreamingManager service.
 * This service is responsible for creating, managing, and terminating data streams,
 * as well as handling client subscriptions and data distribution.
 */
export interface IStreamingManager {
  /**
   * Initializes the StreamingManager with its configuration.
   * This method must be called successfully before any other operations.
   *
   * @public
   * @async
   * @param {StreamingManagerConfig} config - The configuration for the manager.
   * @returns {Promise<void>} A promise that resolves upon successful initialization.
   * @throws {GMIError} If configuration is invalid or initialization fails.
   */
  initialize(config: StreamingManagerConfig): Promise<void>;

  /**
   * Creates a new data stream and returns its unique ID.
   *
   * @public
   * @param {StreamId} [requestedStreamId] - Optional. If provided, attempts to use this ID.
   * If not provided or if the ID already exists, a new unique ID will be generated.
   * @returns {Promise<StreamId>} A promise resolving to the unique ID of the created stream.
   * @throws {StreamError} If the maximum number of concurrent streams is reached,
   * or if a `requestedStreamId` is provided but already in use (and regeneration is not supported/fails).
   */
  createStream(requestedStreamId?: StreamId): Promise<StreamId>;

  /**
   * Registers a client to a specific stream to receive data chunks.
   *
   * @public
   * @async
   * @param {StreamId} streamId - The ID of the stream to subscribe to.
   * @param {IStreamClient} client - The client instance that implements `IStreamClient`.
   * @returns {Promise<void>} A promise that resolves when the client is successfully registered.
   * @throws {StreamError} If the stream does not exist, if the client is already registered,
   * or if the maximum number of clients for the stream is reached.
   */
  registerClient(streamId: StreamId, client: IStreamClient): Promise<void>;

  /**
   * Deregisters a client from a specific stream.
   * The client will no longer receive data chunks for this stream.
   *
   * @public
   * @async
   * @param {StreamId} streamId - The ID of the stream to unsubscribe from.
   * @param {StreamClientId} clientId - The ID of the client to deregister.
   * @returns {Promise<void>} A promise that resolves when the client is successfully deregistered.
   * @throws {StreamError} If the stream or client does not exist within that stream.
   */
  deregisterClient(streamId: StreamId, clientId: StreamClientId): Promise<void>;

  /**
   * Pushes a data chunk to all clients currently subscribed to the specified stream.
   *
   * @public
   * @async
   * @param {StreamId} streamId - The ID of the stream to push data to.
   * @param {AgentOSResponse} chunk - The data chunk to distribute.
   * @returns {Promise<void>} A promise that resolves when the chunk has been pushed to all
   * active clients of the stream (or attempted, based on `onClientSendErrorBehavior`).
   * @throws {StreamError} If the stream does not exist, or if `onClientSendErrorBehavior` is 'throw'
   * and a client send fails.
   */
  pushChunk(streamId: StreamId, chunk: AgentOSResponse): Promise<void>;

  /**
   * Closes a specific stream. All subscribed clients will be notified and subsequently deregistered.
   * No further data can be pushed to a closed stream.
   *
   * @public
   * @async
   * @param {StreamId} streamId - The ID of the stream to close.
   * @param {string} [reason] - An optional reason for closing the stream.
   * @returns {Promise<void>} A promise that resolves when the stream is closed and clients are notified.
   * @throws {StreamError} If the stream does not exist.
   */
  closeStream(streamId: StreamId, reason?: string): Promise<void>;

  /**
   * Handles an error that occurred on a specific stream.
   * This might involve notifying clients with an error chunk and/or closing the stream.
   *
   * @public
   * @async
   * @param {StreamId} streamId - The ID of the stream where the error occurred.
   * @param {Error} error - The error object.
   * @param {boolean} [terminateStream=true] - If true, the stream will be closed after processing the error.
   * @returns {Promise<void>} A promise that resolves when the error has been handled.
   * @throws {StreamError} If the stream does not exist.
   */
  handleStreamError(streamId: StreamId, error: Error, terminateStream?: boolean): Promise<void>;

  /**
   * Retrieves a list of IDs for all currently active streams.
   *
   * @public
   * @returns {Promise<StreamId[]>} A promise resolving to an array of active stream IDs.
   */
  getActiveStreamIds(): Promise<StreamId[]>;

  /**
   * Retrieves the number of clients currently subscribed to a specific stream.
   *
   * @public
   * @async
   * @param {StreamId} streamId - The ID of the stream.
   * @returns {Promise<number>} A promise resolving to the number of clients.
   * @throws {StreamError} If the stream does not exist.
   */
  getClientCountForStream(streamId: StreamId): Promise<number>;

  /**
   * Gracefully shuts down the StreamingManager, closing all active streams
   * and releasing any resources.
   *
   * @public
   * @async
   * @returns {Promise<void>} A promise that resolves when shutdown is complete.
   */
  shutdown(): Promise<void>;
}

/**
 * Internal representation of a managed stream.
 * @interface ManagedStream
 * @private
 */
interface ManagedStream {
  id: StreamId;
  clients: Map<StreamClientId, IStreamClient>;
  createdAt: number;
  lastActivityAt: number;
  metadata?: {
    gmiInstanceId?: string;
    personaId?: string;
    [key: string]: any;
  };
}

/**
 * @class StreamingManager
 * @implements {IStreamingManager}
 * Manages real-time data streams for AgentOS, handling client subscriptions
 * and chunk distribution.
 */
export class StreamingManager implements IStreamingManager {
  private config!: Readonly<Required<StreamingManagerConfig>>;
  private activeStreams: Map<StreamId, ManagedStream>;
  private isInitialized: boolean = false;
  public readonly managerId: string;

  constructor() {
    this.managerId = `streaming-mgr-${uuidv4()}`;
    this.activeStreams = new Map();
  }

  /** @inheritdoc */
  public async initialize(config: StreamingManagerConfig): Promise<void> {
    if (this.isInitialized) {
      console.warn(`StreamingManager (ID: ${this.managerId}) already initialized. Re-initializing.`);
      await this.shutdown(true);
    }

    this.config = Object.freeze({
      maxConcurrentStreams: config.maxConcurrentStreams === undefined || config.maxConcurrentStreams <= 0 ? Infinity : config.maxConcurrentStreams,
      defaultStreamInactivityTimeoutMs: config.defaultStreamInactivityTimeoutMs === undefined ? 300000 : config.defaultStreamInactivityTimeoutMs,
      maxClientsPerStream: config.maxClientsPerStream === undefined || config.maxClientsPerStream <= 0 ? Infinity : config.maxClientsPerStream,
      onClientSendErrorBehavior: config.onClientSendErrorBehavior || 'log_and_continue',
    });

    this.isInitialized = true;
    console.log(`StreamingManager (ID: ${this.managerId}) initialized. Config:`, JSON.stringify(this.config));
  }

  /**
   * Ensures the manager has been properly initialized before any operations.
   * @private
   * @throws {StreamError} If the engine is not initialized.
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new StreamError(
        `StreamingManager (ID: ${this.managerId}) is not initialized. Call initialize() first.`,
        GMIErrorCode.NOT_INITIALIZED,
      );
    }
  }

  /** @inheritdoc */
  public async createStream(requestedStreamId?: StreamId): Promise<StreamId> {
    this.ensureInitialized();

    if (this.activeStreams.size >= this.config.maxConcurrentStreams) {
      throw new StreamError(
        'Maximum number of concurrent streams reached.',
        GMIErrorCode.RATE_LIMIT_EXCEEDED,
        undefined,
        undefined,
        { maxStreams: this.config.maxConcurrentStreams },
      );
    }

    let streamId = requestedStreamId || uuidv4();
    if (this.activeStreams.has(streamId)) {
      if (requestedStreamId) {
        throw new StreamError(
          `Stream with requested ID '${streamId}' already exists.`,
          GMIErrorCode.RESOURCE_ALREADY_EXISTS,
          streamId,
        );
      }
      streamId = uuidv4(); 
    }

    const now = Date.now();
    const newStream: ManagedStream = {
      id: streamId,
      clients: new Map<StreamClientId, IStreamClient>(),
      createdAt: now,
      lastActivityAt: now,
      metadata: {}, // Initialize empty metadata
    };
    this.activeStreams.set(streamId, newStream);
    console.log(`StreamingManager (ID: ${this.managerId}): Stream '${streamId}' created.`);
    return streamId;
  }

  /** @inheritdoc */
  public async registerClient(streamId: StreamId, client: IStreamClient): Promise<void> {
    this.ensureInitialized();
    const stream = this.activeStreams.get(streamId);

    if (!stream) {
      throw new StreamError(`Stream with ID '${streamId}' not found. Cannot register client.`, GMIErrorCode.RESOURCE_NOT_FOUND, streamId);
    }

    if (stream.clients.has(client.id)) {
      console.warn(`StreamingManager (ID: ${this.managerId}): Client '${client.id}' is already registered to stream '${streamId}'. Ignoring.`);
      return;
    }

    if (stream.clients.size >= this.config.maxClientsPerStream) {
      throw new StreamError(
        `Maximum number of clients reached for stream '${streamId}'.`,
        GMIErrorCode.RATE_LIMIT_EXCEEDED,
        streamId,
        client.id,
        { maxClients: this.config.maxClientsPerStream }
      );
    }

    stream.clients.set(client.id, client);
    stream.lastActivityAt = Date.now();
    console.log(`StreamingManager (ID: ${this.managerId}): Client '${client.id}' registered to stream '${streamId}'. Total clients: ${stream.clients.size}.`);
  }

  /** @inheritdoc */
  public async deregisterClient(streamId: StreamId, clientId: StreamClientId): Promise<void> {
    this.ensureInitialized();
    const stream = this.activeStreams.get(streamId);

    if (!stream) {
      console.warn(`StreamingManager (ID: ${this.managerId}): Stream '${streamId}' not found during deregisterClient for client '${clientId}'. Client is effectively deregistered.`);
      return;
    }

    if (!stream.clients.has(clientId)) {
      console.warn(`StreamingManager (ID: ${this.managerId}): Client '${clientId}' not found in stream '${streamId}' during deregistration attempt.`);
      return;
    }

    const clientInstance = stream.clients.get(clientId);
    stream.clients.delete(clientId);
    stream.lastActivityAt = Date.now();
    console.log(`StreamingManager (ID: ${this.managerId}): Client '${clientId}' deregistered from stream '${streamId}'. Remaining clients: ${stream.clients.size}.`);

    if (clientInstance?.close && typeof clientInstance.close === 'function') {
      try {
        await clientInstance.close('Deregistered by StreamingManager.');
      } catch (closeError: any) {
        console.error(`StreamingManager (ID: ${this.managerId}): Error closing client '${clientId}' during deregistration: ${closeError.message}`, closeError);
      }
    }
  }

  /** @inheritdoc */
  public async pushChunk(streamId: StreamId, chunk: AgentOSResponse): Promise<void> {
    this.ensureInitialized();
    const stream = this.activeStreams.get(streamId);

    if (!stream) {
      console.warn(`StreamingManager (ID: ${this.managerId}): Attempted to push chunk to closed/non-existent stream '${streamId}'. Chunk type=${chunk.type}.`);
      return;
    }

    stream.lastActivityAt = Date.now();
    // Update stream metadata if chunk contains relevant info (e.g., GMI instance ID)
    if (chunk.gmiInstanceId && stream.metadata && !stream.metadata.gmiInstanceId) {
        stream.metadata.gmiInstanceId = chunk.gmiInstanceId;
    }
    if (chunk.personaId && stream.metadata && !stream.metadata.personaId) {
        stream.metadata.personaId = chunk.personaId;
    }


    const deliveryPromises: Promise<void>[] = [];
    const failedClientIds: StreamClientId[] = [];

    for (const [clientId, client] of stream.clients.entries()) {
      if (client.isActive()) {
        const sendPromise = client.sendChunk(chunk)
          .catch(async (error: Error) => { // Explicitly type error
            console.error(`StreamingManager (ID: ${this.managerId}): Failed to send chunk to client '${clientId}' on stream '${streamId}'. Behavior: '${this.config.onClientSendErrorBehavior}'. Error: ${error.message}`, error);
            failedClientIds.push(clientId);
            if (this.config.onClientSendErrorBehavior === 'throw') {
              throw new StreamError(
                `Failed to send chunk to client '${clientId}'. Original error: ${error.message}`,
                GMIErrorCode.STREAM_ERROR,
                streamId,
                clientId,
                error
              );
            }
          });
        deliveryPromises.push(sendPromise);
      } else {
        console.warn(`StreamingManager (ID: ${this.managerId}): Client '${clientId}' on stream '${streamId}' is inactive. Marking for potential deregistration.`);
        failedClientIds.push(clientId);
      }
    }

    await Promise.allSettled(deliveryPromises);

    if ((this.config.onClientSendErrorBehavior === 'deregister_client' || this.config.onClientSendErrorBehavior === 'log_and_continue') && failedClientIds.length > 0) {
      for (const clientId of failedClientIds) {
        if (stream.clients.has(clientId)) {
          console.log(`StreamingManager (ID: ${this.managerId}): Deregistering client '${clientId}' from stream '${streamId}' due to send error/inactivity.`);
          await this.deregisterClient(streamId, clientId).catch(deregError => {
            console.error(`StreamingManager (ID: ${this.managerId}): Error auto-deregistering client '${clientId}': ${(deregError as Error).message}`, deregError);
          });
        }
      }
    }
  }

  /** @inheritdoc */
  public async closeStream(streamId: StreamId, reason?: string): Promise<void> {
    this.ensureInitialized();
    const stream = this.activeStreams.get(streamId);

    if (!stream) {
      console.warn(`StreamingManager (ID: ${this.managerId}): Attempted to close non-existent stream '${streamId}'.`);
      return;
    }

    console.log(`StreamingManager (ID: ${this.managerId}): Closing stream '${streamId}'. Reason: ${reason || 'N/A'}. Notifying ${stream.clients.size} clients.`);
    const clientNotificationPromises: Promise<void>[] = [];
    for (const client of stream.clients.values()) {
      clientNotificationPromises.push(
        client.notifyStreamClosed(reason)
          .catch(error => console.error(`StreamingManager (ID: ${this.managerId}): Error notifying client '${client.id}' about stream '${streamId}' closure: ${(error as Error).message}`, error))
      );
      if (client.close && typeof client.close === 'function') {
          clientNotificationPromises.push(
              client.close(`Stream '${streamId}' closed: ${reason || 'No reason provided.'}`)
                  .catch(closeError => console.error(`StreamingManager (ID: ${this.managerId}): Error closing client connection '${client.id}' for stream '${streamId}': ${(closeError as Error).message}`, closeError))
          );
      }
    }

    await Promise.allSettled(clientNotificationPromises);
    this.activeStreams.delete(streamId);
    console.log(`StreamingManager (ID: ${this.managerId}): Stream '${streamId}' and its client references removed.`);
  }

  /** @inheritdoc */
  public async handleStreamError(streamId: StreamId, error: Error, terminateStream: boolean = true): Promise<void> {
    this.ensureInitialized();
    const stream = this.activeStreams.get(streamId);

    if (!stream) {
      console.error(`StreamingManager (ID: ${this.managerId}): Received error for non-existent stream '${streamId}'. Error: ${error.message}`, error);
      return;
    }

    console.error(`StreamingManager (ID: ${this.managerId}): Handling error on stream '${streamId}'. Error: ${error.message}. Terminate: ${terminateStream}`, error);

    const errorChunk: AgentOSErrorChunk = {
      type: AgentOSResponseChunkType.ERROR,
      streamId: streamId,
      gmiInstanceId: stream.metadata?.gmiInstanceId || 'unknown_gmi',
      personaId: stream.metadata?.personaId || 'unknown_persona',
      isFinal: true,
      timestamp: new Date().toISOString(),
      // Accessing error.code is fine if error is GMIError, but not if it's a base Error.
      // The type guard correctly handles this.
      code: (error instanceof GMIError) ? error.code : GMIErrorCode.STREAM_ERROR,
      message: error.message,
      // Accessing error.details is fine if error is GMIError.
      // The type guard handles this. The fallback for details for a generic Error is also fine.
      details: (error instanceof GMIError) ? error.details : { name: error.name, stack: error.stack },
    };

    try {
      await this.pushChunk(streamId, errorChunk);
    } catch (pushError: any) {
      console.error(`StreamingManager (ID: ${this.managerId}): Failed to push error chunk to clients of stream '${streamId}'. Push error: ${pushError.message}`, pushError);
    }

    if (terminateStream) {
      await this.closeStream(streamId, `Stream terminated due to error: ${error.message}`);
    }
  }

  /** @inheritdoc */
  public async getActiveStreamIds(): Promise<StreamId[]> {
    this.ensureInitialized();
    return Array.from(this.activeStreams.keys());
  }

  /** @inheritdoc */
  public async getClientCountForStream(streamId: StreamId): Promise<number> {
    this.ensureInitialized();
    const stream = this.activeStreams.get(streamId);
    if (!stream) {
      throw new StreamError(`Stream with ID '${streamId}' not found.`, GMIErrorCode.RESOURCE_NOT_FOUND, streamId);
    }
    return stream.clients.size;
  }

  /** @inheritdoc */
  public async shutdown(isReinitializing: boolean = false): Promise<void> {
    if (!this.isInitialized && !isReinitializing) {
      console.warn(`StreamingManager (ID: ${this.managerId}) shutdown called but was not initialized or already shut down.`);
      return;
    }
    console.log(`StreamingManager (ID: ${this.managerId}): Shutting down... Closing ${this.activeStreams.size} active streams.`);
    const streamIdsToClose = Array.from(this.activeStreams.keys());
    for (const streamId of streamIdsToClose) {
      try {
        await this.closeStream(streamId, 'StreamingManager is shutting down.');
      } catch (error: any) {
        console.error(`StreamingManager (ID: ${this.managerId}): Error closing stream '${streamId}' during shutdown: ${error.message}`, error);
      }
    }
    this.activeStreams.clear();
    if (!isReinitializing) {
        this.isInitialized = false;
    }
    console.log(`StreamingManager (ID: ${this.managerId}): Shutdown complete. All streams closed and cache cleared.`);
  }
}

import { createServer, IncomingMessage, Server as HTTPServer, ServerResponse } from 'http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AgentOS } from '../AgentOS.js';
import type { AgentOSConfig } from '../AgentOS.js';
import type { AgentOSInput } from '../types/AgentOSInput.js';
import type { AgentOSResponse } from '../types/AgentOSResponse.js';
import { AgentOSServerConfig } from './config/ServerConfig';
import { moduleLogger } from '../../core/logging/loggerFactory.js';
import { getLoggingState } from '../../core/logging/state.js';
import { listedErrorFields } from '../../core/logging/events.js';

/** The server's events, to the target current when each is written; each line of a request carries its id. */
const log = moduleLogger('http', 'agentos_server');

/** The methods an `http.request` line names; any other is written as `OTHER`. */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'] as const;
type Method = (typeof METHODS)[number] | 'OTHER';

/**
 * The route an `http.request` line names: one of the server's own paths, or a fixed word for the rest, so no path a
 * client sent, its query or a parameter in it reaches a line.
 */
type Route = '/health' | '/api/agentos/personas' | '/api/agentos/chat' | 'preflight' | 'extension' | 'unmatched' | 'unready';

/**
 * The route a request names before AgentOS is ready, from its method and path alone, so a request given up on while
 * AgentOS starts keeps its route. An extension's request reads `unmatched` until a handler takes it.
 */
function routeOf(req: IncomingMessage): Route {
  if (req.method === 'OPTIONS') return 'preflight';
  let path: string;
  try { path = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { return 'unmatched'; }
  if (req.method === 'GET' && path === '/health') return '/health';
  if (req.method === 'GET' && path === '/api/agentos/personas') return '/api/agentos/personas';
  if (req.method === 'POST' && path === '/api/agentos/chat') return '/api/agentos/chat';
  return 'unmatched';
}

/** What one request's completion line is built from, filled in as the request is handled. */
interface RequestRecord {
  route: Route;
  /** Set when a handler threw, so the line reads `error` whatever the status. */
  failed: boolean;
}

interface ChatRequestPayload {
  userId?: string;
  sessionId?: string;
  personaId?: string;
  conversationId?: string;
  text?: string;
  options?: AgentOSInput['options'];
}

export class AgentOSServer {
  private agentOS: AgentOS;
  private readonly server: HTTPServer;
  private readonly config: AgentOSServerConfig;
  private agentReady: Promise<void>;

  constructor(agentOSConfig: AgentOSConfig, serverConfig: AgentOSServerConfig) {
    this.config = serverConfig;
    this.agentOS = new AgentOS();
    this.agentReady = this.agentOS.initialize(agentOSConfig);
    this.server = createServer((req, res) => this.receive(req, res));
  }

  /**
   * Runs one request under a fresh id. The id is returned in `x-request-id`, and every AgentOS event line written
   * while the request runs carries it as `requestId`. When the response closes, one `http.request` line gives the
   * method, the route as the server names it, the status (0 when no status was sent), the milliseconds and the
   * outcome: `error` for a 5xx status or a handler that threw, even when the connection then closed early, otherwise
   * `aborted` when the connection closed before the response finished, otherwise `ok`. It is written at `error`,
   * `warn` or `info` to match. A handler's failure is written once, as `http.handler_failed`.
   */
  private receive(req: IncomingMessage, res: ServerResponse): void {
    const requestId = randomUUID();
    const started = performance.now();
    const record: RequestRecord = { route: routeOf(req), failed: false };
    const requests = getLoggingState().requests;
    res.setHeader('x-request-id', requestId);
    // A close that comes from the socket runs outside the request's context, so the line enters it again.
    res.once('close', () => requests.run({ requestId }, () => {
      const status = res.headersSent ? res.statusCode : 0;
      const outcome = record.failed || status >= 500 ? 'error' : !res.writableFinished ? 'aborted' : 'ok';
      const method: Method = (METHODS as readonly string[]).includes(req.method ?? '') ? req.method as Method : 'OTHER';
      const fields = { method, route: record.route, status, ms: Math.max(0, Math.round(performance.now() - started)), outcome } as const;
      if (outcome === 'ok') log.info('http.request', fields);
      else if (outcome === 'error') log.error('http.request', fields);
      else log.warn('http.request', fields);
    }));
    requests.run({ requestId }, () => {
      void this.handleRequest(req, res, record).catch((error: unknown) => {
        // A failure an extension's handler already wrote is not written again.
        if (!record.failed) { record.failed = true; log.error('http.handler_failed', listedErrorFields(error)); }
        if (!res.headersSent) this.sendJson(res, 500, { error: 'Internal Server Error' });
        else res.destroy();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse, record: RequestRecord): Promise<void> {
    try {
      await this.agentReady;
    } catch (error) {
      record.route = 'unready';
      this.sendJson(res, 500, { error: 'AgentOS failed to initialise', details: (error as Error).message });
      return;
    }

    // Basic CORS handling for development/testing.
    if (this.config.enableCors) {
      res.setHeader('Access-Control-Allow-Origin', this.config.corsOrigin ?? '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Expose-Headers', 'x-request-id');
    }

    if (req.method === 'OPTIONS') {
      record.route = 'preflight';
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host || this.config.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      record.route = '/health';
      this.sendJson(res, 200, { status: 'ok', service: 'agentos-server' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/agentos/personas') {
      record.route = '/api/agentos/personas';
      await this.handleListPersonasRequest(url, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/agentos/chat') {
      record.route = '/api/agentos/chat';
      await this.handleChatRequest(req, res);
      return;
    }

    if (this.config.dispatchExtensionHandlers !== false) {
      for (const handler of this.agentOS.getHttpHandlers()) {
        // Set before the call: a handler that claims the request may answer it before it returns.
        record.route = 'extension';
        try {
          if (await handler(req, res)) return;
        } catch (error) {
          // The error is written as its type and code alone; its text, which can carry internal or sensitive strings,
          // reaches neither the line nor the client.
          record.failed = true;
          log.error('http.handler_failed', listedErrorFields(error));
          // A handler that began its response before it threw has its connection closed; a status cannot follow.
          if (!res.headersSent) this.sendJson(res, 500, { error: 'Extension HTTP handler error' });
          else res.destroy();
          return;
        }
        record.route = 'unmatched';
      }
    }

    this.sendJson(res, 404, { error: 'Not Found' });
  }

  /**
   * Test seam: replace the embedded AgentOS (unit tests only). Silences the
   * original readiness promise so a pending initialize() rejection from the
   * constructor cannot surface as an unhandled rejection.
   */
  public setAgentOSForTesting(stub: AgentOS): void {
    void this.agentReady.catch(() => undefined);
    this.agentOS = stub;
    this.agentReady = Promise.resolve();
  }

  private async handleListPersonasRequest(url: URL, res: ServerResponse): Promise<void> {
    try {
      const userId = url.searchParams.get('userId') ?? undefined;
      const personas = await this.agentOS.listAvailablePersonas(userId);
      this.sendJson(res, 200, { personas });
    } catch (error) {
      this.sendJson(res, 500, { error: 'Failed to list personas', details: (error as Error).message });
    }
  }

  private async handleChatRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let payload: ChatRequestPayload;
    try {
      const rawBody = await this.readBody(req);
      payload = JSON.parse(rawBody || '{}');
    } catch (error) {
      this.sendJson(res, 400, { error: 'Invalid JSON body', details: (error as Error).message });
      return;
    }

    if (!payload.text || typeof payload.text !== 'string') {
      this.sendJson(res, 400, { error: 'Missing text field in request body.' });
      return;
    }

    const agentInput: AgentOSInput = {
      userId: payload.userId ?? 'anonymous_user',
      sessionId: payload.sessionId ?? `session_${Date.now()}`,
      conversationId: payload.conversationId,
      selectedPersonaId: payload.personaId,
      textInput: payload.text,
      options: payload.options,
    };

    try {
      const chunks: AgentOSResponse[] = [];
      for await (const chunk of this.agentOS.processRequest(agentInput)) {
        chunks.push(chunk);
      }
      this.sendJson(res, 200, { chunks });
    } catch (error) {
      this.sendJson(res, 500, { error: 'AgentOS processing failed', details: (error as Error).message });
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const maxBytes = this.parseSizeToBytes(this.config.maxRequestSize ?? '1mb');
      let received = 0;
      const chunks: Buffer[] = [];

      req.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });

      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });

      req.on('error', (error) => reject(error));
    });
  }

  private parseSizeToBytes(value: string): number {
    const match = value.trim().toLowerCase().match(/^(\d+)(b|kb|mb|gb)?$/);
    if (!match) return 1024 * 1024; // default 1MB
    const size = Number(match[1]);
    const unit = match[2] ?? 'b';
    switch (unit) {
      case 'gb':
        return size * 1024 * 1024 * 1024;
      case 'mb':
        return size * 1024 * 1024;
      case 'kb':
        return size * 1024;
      default:
        return size;
    }
  }

  private sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  public async start(): Promise<void> {
    await this.agentReady;
    const port = this.config.port ?? 3001;
    const host = this.config.host ?? '0.0.0.0';
    await new Promise<void>((resolve) => {
      this.server.listen(port, host, () => resolve());
    });
  }

  public async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.agentOS.shutdown();
  }

  public getServer(): HTTPServer {
    return this.server;
  }
}

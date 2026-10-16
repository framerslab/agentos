/**
 * @fileoverview Stub module declarations for optional channel adapter dependencies.
 *
 * These packages are dynamically imported at runtime and only required when
 * the corresponding adapter is actually initialized. The stubs prevent
 * TS2307 errors during compilation without requiring the packages to be
 * installed as devDependencies.
 */

declare module 'discord.js' {
  export class Client {
    constructor(options?: any);
    login(token: string): Promise<string>;
    on(event: string, listener: (...args: any[]) => void): this;
    destroy(): Promise<void>;
    user: any;
    channels: any;
    guilds: any;
  }
  export class Collection<K, V> extends Map<K, V> {}
  export const GatewayIntentBits: Record<string, number>;
  export const Partials: Record<string, number>;
}

declare module 'telegraf' {
  export class Telegraf {
    constructor(token: string, options?: any);
    launch(options?: any): Promise<void>;
    stop(signal?: string): void;
    on(event: string, handler: (...args: any[]) => void): void;
    command(command: string, handler: (...args: any[]) => void): void;
    telegram: any;
    botInfo: any;
  }
}

declare module 'grammy' {
  export class Bot {
    constructor(token: string, options?: any);
    start(options?: any): Promise<void>;
    stop(): void;
    on(event: string, handler: (...args: any[]) => void): void;
    command(command: string, handler: (...args: any[]) => void): void;
    api: any;
    botInfo: any;
  }
}

declare module '@slack/bolt' {
  export class App {
    constructor(options?: any);
    start(port?: number): Promise<void>;
    stop(): Promise<void>;
    event(event: string, handler: (...args: any[]) => void): void;
    message(pattern: any, handler: (...args: any[]) => void): void;
    client: any;
  }
}

declare module 'twilio' {
  function twilio(accountSid: string, authToken: string): any;
  export = twilio;
}

declare module 'twitter-api-v2' {
  export class TwitterApi {
    constructor(options: any);
    v2: any;
    readOnly: any;
    readWrite: any;
  }
}

declare module 'snoowrap' {
  class Snoowrap {
    constructor(options: any);
    getInbox(options?: any): Promise<any[]>;
    getComment(id: string): any;
    getSubmission(id: string): any;
    composeMessage(options: any): Promise<any>;
  }
  export = Snoowrap;
}

declare module 'irc-framework' {
  export class Client {
    constructor();
    connect(options: any): void;
    quit(message?: string): void;
    say(target: string, message: string): void;
    join(channel: string): void;
    on(event: string, handler: (...args: any[]) => void): void;
    user: any;
  }
}

// The type checker resolves 'ws' to this declaration ahead of the installed
// @types/ws, so each part of the ws API the library calls is declared here.
declare module 'ws' {
  import { EventEmitter } from 'events';
  import { IncomingMessage, Server as HTTPServer } from 'http';
  import { AddressInfo } from 'net';
  import { Duplex } from 'stream';

  class WebSocket extends EventEmitter {
    /** A client that offers `protocols` as its subprotocols in the handshake. */
    constructor(address: string | URL, protocols?: string | string[], options?: any);
    constructor(address: string | URL, options?: any);
    send(data: any, cb?: (err?: Error) => void): void;
    close(code?: number, reason?: string): void;
    /** Forcibly closes the connection, or aborts the handshake while it is still connecting. */
    terminate(): void;
    readyState: number;
    /** Bytes queued by `send()` and not yet written to the socket. */
    readonly bufferedAmount: number;
    /** The open ready state, on the instance as well as the class. */
    readonly OPEN: number;
    static OPEN: number;
    static CLOSED: number;
    static CONNECTING: number;
    static CLOSING: number;
  }

  /** The connection type, named for the namespace's own `WebSocket` export. */
  type WebSocketConnection = WebSocket;

  namespace WebSocket {
    /** The payload of a received message. */
    type RawData = Buffer | ArrayBuffer | Buffer[];
    /** A connection, as the named `WebSocket` export. */
    type WebSocket = WebSocketConnection;

    class Server extends EventEmitter {
      constructor(options?: {
        server?: HTTPServer;
        port?: number;
        path?: string;
        noServer?: boolean;
        maxPayload?: number;
        perMessageDeflate?: boolean;
        /** Picks the subprotocol to answer with; `false` answers with none and does not refuse the handshake. */
        handleProtocols?: (protocols: Set<string>, request: IncomingMessage) => string | false;
        [key: string]: any;
      });
      close(cb?: (err?: Error) => void): void;
      /** The address of the server it created, as `net.Server.address()` gives it; null before it listens. */
      address(): AddressInfo | string | null;
      clients: Set<WebSocket>;
      /** Completes an upgrade the caller accepted, for a server created with `noServer`. */
      handleUpgrade(request: IncomingMessage, socket: Duplex, upgradeHead: Buffer, callback: (client: WebSocket, request: IncomingMessage) => void): void;
    }

    /** The named export of {@link Server}. */
    const WebSocketServer: typeof Server;
    type WebSocketServer = Server;
  }

  export = WebSocket;
}

declare module 'botframework-connector' {
  export class MicrosoftAppCredentials {
    constructor(appId: string, appPassword: string);
  }
  export class ConnectorClient {
    constructor(credentials: any, options?: any);
    conversations: any;
  }
}

declare module 'botbuilder' {
  export class BotFrameworkAdapter {
    constructor(settings?: any);
    processActivity(req: any, res: any, logic: (context: any) => Promise<void>): Promise<void>;
    continueConversation(reference: any, logic: (context: any) => Promise<void>): Promise<void>;
  }
  export class TurnContext {
    activity: any;
    sendActivity(activity: any): Promise<any>;
  }
}

declare module 'googleapis' {
  export const google: {
    chat(version: string): any;
    auth: {
      GoogleAuth: new (options?: any) => any;
    };
  };
}

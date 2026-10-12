/**
 * @module channels/meetings/MeetingRoom
 *
 * The room-per-run helper. A run's LiveKit room is made at dispatch, never at
 * scheduling: an empty room closes after its empty timeout and a join token
 * expires, so a room made ahead of its meeting would be gone or unusable when
 * the bot connects. The bot gets a publish-only token and the listening agent
 * a subscribe-only one. The library imports no LiveKit server package: the
 * host implements {@link IMeetingRoomService} on the server SDK it already
 * holds.
 */

/** What the product implements on its LiveKit server SDK. */
export interface IMeetingRoomService {
  /** The url a participant connects to (`wss://…`). */
  readonly url: string;
  /** Creates the room, which the server closes when nobody has joined within `emptyTimeoutSeconds` or `departureTimeoutSeconds` after the last participant leaves, and which holds at most `maxParticipants` at once. A room of that name that exists already is not an error (LiveKit's `CreateRoom` returns it): a dispatch tried again after a failure may ask for a room its first attempt made. */
  createRoom(input: { name: string; emptyTimeoutSeconds: number; departureTimeoutSeconds: number; maxParticipants: number }): Promise<void>;
  /** Deletes the room. For a room that does not exist it must reject with an error whose `status` is 404 (the LiveKit server SDK's errors carry the response's HTTP status, so passing its error through does). */
  deleteRoom(name: string): Promise<void>;
  /** Mints a join token for one identity in one room with exactly the publish and subscribe rights given and no right to publish data, valid for `ttlSeconds`. With the LiveKit server SDK, set `canPublishData: false` in the grant: left unset, LiveKit allows data wherever `canPublish` is true. */
  mintToken(input: { room: string; identity: string; canPublish: boolean; canSubscribe: boolean; ttlSeconds: number }): Promise<string>;
}

/** How a host shapes each run's room. Every field has a default. */
export interface MeetingRoomOptions {
  /** Put before the run id to name the room. Default `'bot-'`. */
  prefix?: string;
  /** Seconds the room stays open before anyone joins. Default 60. */
  emptyTimeoutSeconds?: number;
  /** Seconds the room stays open after the last participant leaves. Default 45. */
  departureTimeoutSeconds?: number;
  /** Seconds each token stays valid, long enough for the bot to connect after dispatch. Default 600. */
  tokenTtlSeconds?: number;
  /** The bot's identity in the room. Default `'bot'`. */
  botIdentity?: string;
  /** The listening agent's identity in the room. Default `'agent'`. */
  agentIdentity?: string;
}

/** A run's room as {@link MeetingRoom.create} made it. The two tokens are secrets: the manager keeps neither on the run's record. */
export interface MeetingRoomHandle {
  /** The service's url, the address the bot is given. An agent that reaches the server by another address, such as one inside the host's own network, connects there. */
  url: string;
  /** The room's name: the prefix, then the run id. */
  name: string;
  /** The identity the bot joins as. */
  botIdentity: string;
  /** The identity the listening agent joins as. */
  agentIdentity: string;
  /** The bot's token: it may publish and may not subscribe. */
  publishToken: string;
  /** The agent's token: it may subscribe and may not publish. */
  subscribeToken: string;
}

/** One room per run, made at dispatch: a publish-only token for the bot, a subscribe-only token for the agent. */
export class MeetingRoom {
  private readonly prefix: string;
  private readonly emptyTimeoutSeconds: number;
  private readonly departureTimeoutSeconds: number;
  private readonly tokenTtlSeconds: number;
  private readonly botIdentity: string;
  private readonly agentIdentity: string;

  /**
   * @param service - The host's room service on its LiveKit server SDK.
   * @param options - The name prefix, the timeouts, the tokens' lifetime and the two identities; each has a default.
   */
  constructor(private readonly service: IMeetingRoomService, options: MeetingRoomOptions = {}) {
    this.prefix = options.prefix ?? 'bot-';
    this.emptyTimeoutSeconds = options.emptyTimeoutSeconds ?? 60;
    this.departureTimeoutSeconds = options.departureTimeoutSeconds ?? 45;
    this.tokenTtlSeconds = options.tokenTtlSeconds ?? 600;
    this.botIdentity = options.botIdentity ?? 'bot';
    this.agentIdentity = options.agentIdentity ?? 'agent';
  }

  /**
   * Makes the run's room, the prefix then the run id, for two participants (the bot and the agent), and mints the
   * bot's publish-only token and the agent's subscribe-only token for it. Call it at dispatch, never at scheduling.
   */
  async create(runId: string): Promise<MeetingRoomHandle> {
    const name = `${this.prefix}${runId}`;
    await this.service.createRoom({ name, emptyTimeoutSeconds: this.emptyTimeoutSeconds, departureTimeoutSeconds: this.departureTimeoutSeconds, maxParticipants: 2 });
    const publishToken = await this.service.mintToken({ room: name, identity: this.botIdentity, canPublish: true, canSubscribe: false, ttlSeconds: this.tokenTtlSeconds });
    const subscribeToken = await this.service.mintToken({ room: name, identity: this.agentIdentity, canPublish: false, canSubscribe: true, ttlSeconds: this.tokenTtlSeconds });
    return { url: this.service.url, name, botIdentity: this.botIdentity, agentIdentity: this.agentIdentity, publishToken, subscribeToken };
  }

  /** Deletes the room; a room that is already gone is not an error. The service reports a missing room with `status` 404; any other error is thrown. */
  async delete(name: string): Promise<void> {
    try {
      await this.service.deleteRoom(name);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return;
      throw err;
    }
  }
}

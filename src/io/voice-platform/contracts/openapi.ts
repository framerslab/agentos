/** OpenAPI 3.1 from canonical runtime schemas. No filesystem, Node or native import belongs here. */
import { z } from 'zod';
import { VOICE_CONTRACT_SCHEMAS, VOICE_HTTP_SCHEMAS } from './schemas.js';

/** Executable TypeScript examples. CI supplies fetch, baseUrl and bearer without external requests. */
export const VOICE_HTTP_EXAMPLES = [
  {
    operationId: 'createWebCall', path: '/web-calls', lang: 'TypeScript',
    source: `const input = {
  agentId: 'agent-a', maxDurationSeconds: 600,
  clientOrigin: 'https://client.example.test',
  proofKeyThumbprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  idempotencyKey: 'create-a'
};
const result = (async () => {
  const response = await fetch(baseUrl + '/web-calls', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error('Call creation refused: ' + response.status);
  return response.json();
})();`,
  },
  {
    operationId: 'stopCall', path: '/calls/call-a/stop', lang: 'TypeScript',
    source: `const input = { idempotencyKey: 'stop-a' };
const result = (async () => {
  const response = await fetch(baseUrl + '/calls/call-a/stop', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error('Call stop refused: ' + response.status);
  return response.json();
})();`,
  },
] as const;

const allSchemas = { ...VOICE_CONTRACT_SCHEMAS, ...VOICE_HTTP_SCHEMAS };
type SchemaName = keyof typeof allSchemas;
const ref = (name: SchemaName) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (name: SchemaName) => ({ required: true, content: { 'application/json': { schema: ref(name) } } });
const jsonResponse = (name: SchemaName, description: string) => ({ description, content: { 'application/json': { schema: ref(name) } } });
const idParameter = { name: 'id', in: 'path', required: true, schema: z.toJSONSchema(VOICE_CONTRACT_SCHEMAS.VoiceCall.shape.callId, { target: 'draft-2020-12', io: 'input' }) };

const originParameter = { name: 'Origin', in: 'header', required: true, schema: z.toJSONSchema(VOICE_CONTRACT_SCHEMAS.CreateWebCall.shape.clientOrigin, { target: 'draft-2020-12', io: 'input' }), description: 'Must equal the origin bound to the credential.' };

const paging = [
  { name: 'limit', in: 'query', required: false, schema: z.toJSONSchema(VOICE_HTTP_SCHEMAS.ListQuery.shape.limit, { target: 'draft-2020-12', io: 'input' }), description: 'The adapter supplies its configured default before parsing ListQuery.' },

  { name: 'cursor', in: 'query', required: false, schema: z.toJSONSchema(VOICE_HTTP_SCHEMAS.ListQuery.shape.cursor, { target: 'draft-2020-12', io: 'input' }), description: 'Opaque authenticated scope/filter cursor over creation time and id.' },

];
const errorMeanings: Record<string, string> = {
  '400': 'Malformed request or proof.', '401': 'Credential absent, invalid, expired or revoked.',
  '403': 'Authenticated authority does not permit this operation.', '404': 'Resource absent or foreign to the authenticated scope.',
  '409': 'Revision, lifecycle or idempotency conflict.', '410': 'Content, grant or recovery window is no longer available.',
  '413': 'Request or authentication frame exceeds its bound.', '422': 'A requested provider, model, limit or policy is not admissible.',
  '429': 'Rate or concurrent-call limit reached; respect retry information.',
  '500': 'Internal failure; no provider exception or caller content is disclosed.',
  '503': 'Capacity or an authoritative dependency is unavailable; respect retry information.',
};
const errors = Object.fromEntries(Object.entries(errorMeanings).map(([status, description]) => [status, jsonResponse('VoiceApiError', description)]));
const security = { server: [{ serverKey: [] as string[] }], grant: [{ callGrant: [] as string[] }], control: [{ callControl: [] as string[] }] };

function operation(operationId: string, summary: string, response: SchemaName, options: { request?: SchemaName; status?: string } = {}) {
  return {
    operationId, summary,
    ...(options.request ? { requestBody: jsonBody(options.request) } : {}),
    responses: { ...errors, [options.status ?? '200']: jsonResponse(response, 'Successful response.') },
    ...(VOICE_HTTP_EXAMPLES.some((example) => example.operationId === operationId)
      ? { 'x-codeSamples': VOICE_HTTP_EXAMPLES.filter((example) => example.operationId === operationId).map(({ lang, source }) => ({ lang, source })) }
      : {}),
  };
}

/**
 * Builds a fresh versioned HTTP description. Relative server URL lets a host mount it under its own origin.
 * Product authentication, credit purchases and account administration compose around these library operations.
 * WebSocket authentication occurs in a bounded first frame, never a credential query parameter.
 */
export function buildVoicePlatformOpenApi() {
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of Object.entries(allSchemas)) registry.add(schema, { id: name });
  const schemas = z.toJSONSchema(registry, {
    target: 'draft-2020-12', io: 'input', cycles: 'throw', reused: 'inline', uri: (name) => `#/components/schemas/${name}`,
  }).schemas;
  // These are embedded components, not separate schema resources. Zod also uses uri for $id.
  for (const schema of Object.values(schemas)) delete schema.$id;

  return {
    openapi: '3.1.1', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Voice platform API', version: '1.0.0',
      description: 'Agent and call contracts. Local in-process calls need no HTTP key. HTTP servers authenticate every private operation. Shape validation never grants authority.',
    },
    servers: [{ url: '/api/v1' }], security: security.server,
    components: {
      schemas,
      securitySchemes: {
        serverKey: { type: 'http', scheme: 'bearer', description: 'Configured server key. The host derives scope and grants; callers cannot select a scope in an input object.' },
        callGrant: { type: 'http', scheme: 'bearer', description: 'Single-call exchange grant, bound to origin and proof key. Recoverable only for the same authenticated exchange operation and hash.' },
        callControl: { type: 'http', scheme: 'bearer', description: 'Revocable single-call stop and control-renewal authority; requires browser proof and grants no account access.' },
        webhookSignature: { type: 'apiKey', in: 'header', name: 'x-webhook-signature', description: 'HMAC-SHA256 over id.timestamp.exactBody, encoded as v1, followed by base64. Verify with the released signing module.' },
      },
    },
    paths: {
      '/agents': {
        get: { ...operation('listAgents', 'List scoped agent revisions', 'AgentList'), parameters: paging },
        post: operation('createAgent', 'Create an agent', 'VoiceAgent', { request: 'CreateAgent', status: '201' }),
      },
      '/agents/{id}': {
        parameters: [idParameter],
        get: operation('getAgent', 'Read the authorized agent revision', 'VoiceAgent'),
        patch: operation('updateAgent', 'Create the next revision after matching expectedRevision', 'VoiceAgent', { request: 'UpdateAgent' }),
        delete: operation('archiveAgent', 'Archive after matching revision; active calls keep their snapshot', 'VoiceAgent', { request: 'ArchiveAgent' }),
      },
      '/web-calls': {
        post: operation('createWebCall', 'Prepare one call, reserve once and issue its grant', 'CallGrant', { request: 'CreateWebCall', status: '201' }),
      },
      '/web-calls/{id}/token': {
        parameters: [idParameter],
        post: operation('renewCallGrant', 'Reauthorize the same nonterminal call', 'CallGrant', { request: 'RenewCallGrant' }),
      },
      '/web-calls/{id}/connect': {
        parameters: [idParameter],
        post: {
          ...operation('connectWebCall', 'Recoverably exchange a grant with the same operation, request hash and proof', 'WebCallConnection', { request: 'ConnectWebCall' }),
          security: security.grant, parameters: [originParameter],
        },
      },
      '/web-calls/{id}/media': {
        parameters: [idParameter],
        get: {
          operationId: 'upgradeCallMedia', summary: 'Upgrade an explicitly selected WebSocket transport',
          security: [], parameters: [originParameter, { name: 'Sec-WebSocket-Protocol', in: 'header', required: true, schema: { type: 'string', const: 'agentos.voice.v1' } }],
          description: 'Upgrade does not authorize a call. Within five seconds send the first bounded JSON authentication frame. Until verification succeeds no audio, inference or billable connection is accepted. Tokens never occur in URLs or handshake fields.',
          'x-first-frame-auth': { schema: ref('MediaAuthentication'), deadlineMs: 5000, maxBytes: 16384, workBeforeAuthentication: false },
          responses: { ...errors, '101': { description: 'Protocol upgrade only; first-frame authentication still required.' } },
        },
      },
      '/calls': { get: { ...operation('listCalls', 'List scoped call metadata', 'CallList'), parameters: paging } },
      '/calls/{id}': {
        parameters: [idParameter], get: operation('getCall', 'Read authorized call metadata', 'VoiceCall'),
        delete: operation('purgeCall', 'Fence content and start idempotent purge; completed requires acknowledged cleanup', 'PurgeReceipt', { request: 'PurgeCall', status: '202' }),
      },
      '/calls/{id}/stop': {
        parameters: [idParameter],
        post: {
          ...operation('stopCall', 'Stop once and recover the stable content-free receipt', 'StopReceipt', { request: 'StopCall' }),
          security: [...security.server, ...security.control],
          description: 'A server key needs its stop grant. A call-control credential additionally needs Origin and a valid proof over this operation. Media connectivity is not required. Retrying the same authenticated stop returns its stored receipt.',
          parameters: [{ ...originParameter, required: false }],
        },
      },
      '/calls/{id}/control-token': {
        parameters: [idParameter],
        post: {
          ...operation('renewCallControl', 'Renew narrow control authority for an active call', 'CallControlCredential', { request: 'RenewCallControl' }),
          security: security.control, parameters: [originParameter],
          description: 'Returns only the separately typed control credential; never opens or renews media.',
        },
      },
      '/calls/{id}/transcript': {
        parameters: [idParameter], get: operation('getCallTranscript', 'Read retained content if current authority and retention permit it', 'TranscriptResult'),
      },
      '/calls/{id}/events': {
        parameters: [idParameter],
        get: {
          operationId: 'streamCallEvents', summary: 'Resume scoped lifecycle events after a sequence',
          parameters: [{ name: 'afterSequence', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }],
          responses: { ...errors, '200': { description: 'SSE data is a CallEvent; id is its sequence. Reconnect resumes without minting terminal events.', content: { 'text/event-stream': { schema: { type: 'string' }, 'x-event-schema': ref('CallEvent') } } } },
        },
      },
      '/usage': { get: { ...operation('listUsage', 'List scoped cumulative quantities', 'UsageList'), parameters: paging } },
    },
    webhooks: {
      callEvent: {
        post: {
          operationId: 'deliverCallEvent', summary: 'Deliver a scoped call lifecycle event',
          description: 'Retries preserve the event id and exact body. Receivers verify signature and timestamp and deduplicate by event id. A call has exactly one terminal event, ended or failed. Content already delivered is outside the sender storage boundary.',
          security: [{ webhookSignature: [] }],
          parameters: [
            { name: 'x-webhook-id', in: 'header', required: true, schema: { type: 'string', maxLength: 128 } },
            { name: 'x-webhook-timestamp', in: 'header', required: true, schema: { type: 'string', pattern: '^[0-9]+$' }, description: 'Epoch milliseconds; the released verifier enforces the five-minute verification window.' },
          ],
          requestBody: jsonBody('CallEvent'),
          responses: { '204': { description: 'Accepted, including an already processed event id.' }, '400': { description: 'Malformed event.' }, '401': { description: 'Signature or timestamp refused.' }, '429': { description: 'Receiver requests retry.' }, '500': { description: 'Receiver failed; delivery may retry.' } },
        },
      },
    },
  };
}

/** Deterministic pretty JSON with one final newline, used both by CI and importing hosts. */
export function serializeVoicePlatformOpenApi(): string {
  return `${JSON.stringify(buildVoicePlatformOpenApi(), null, 2)}\n`;
}

/** The generated document's inferred TypeScript structure. */
export type VoicePlatformOpenApi = ReturnType<typeof buildVoicePlatformOpenApi>;

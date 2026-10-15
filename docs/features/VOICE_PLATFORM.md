# Voice platform runtime

The voice platform module manages a scoped spoken call over the existing voice pipeline. It owns call state, connection intervals, credentials, generations, bounded audio delivery and cleanup. The host supplies authentication, authorized scope, durable stores, provider registrations, reservations and commercial policy. Library availability does not imply a hosted service or a deployed phone offering.

## Entry points

`VoiceSessionFactory.startSession(request)` prepares one reserved call from its immutable `VoiceAgent` revision and `VoiceScopeContext`. Preparation validates provider manifests and policy and acquires scope and host capacity. It makes no model request. Authenticated transport admission starts the pipeline. Repeated preparation of the same call shares its operation; changing the captured request is refused.

The lightweight `agent()` exposes the same factory through `voiceSession()` only when constructed with `voice: { enabled: true, session: { factory, agent: revision } }`. Its request has the factory request's `scope`, `funding` and `slot`; the configured revision is supplied internally. Ordinary text methods do not start audio, and the full runtime's voice flag remains deferred. GMI refuses this configured-session option.

The complete factory configuration and lifecycle are exercised in `src/io/voice-platform/__tests__/VoiceSessionFactory.test.ts`. The local and hosted own-endpoint examples in `examples/voice-platform/` are executable CI fixtures. Their explicit dependencies supply the configured registry, endpoint and credentials; they do not discover a tenant from environment variables.

## Contracts and authority

Runtime schemas in `src/io/voice-platform/contracts/` are canonical closed v1 objects. TypeScript types are inferred from those schemas. CI regenerates OpenAPI 3.1 and compares it with `docs/api/voice-platform.openapi.json`; hosts compose that document rather than copying voice schemas. Scope is derived by authentication and is never selected by a public request body.

Calls retain their initiating principal, agent revision, provider policy, rate reference and attempt allowance. `CallCredentials` exchanges a proof-bound grant for media and separate control credentials. A media credential is one-use and grants only that call's transport. `WebSocketCallServer` consumes it in the first bounded authentication frame, before audio admission. A credential never grants account administration.

The reference server requires a configured bearer key for its single scope. It requires that key in CI fixtures too, and the caller binds the returned server explicitly. It uses in-memory stores and the WebSocket transport; a durable host supplies SQL stores and its own authenticated routes. Local in-process calls have no HTTP credential requirement.

## Providers and memory

`SpeechProviderResolver.resolveVoicePlan` uses typed registered factories, checks models, revisions, language, rate, codec, voice and closed options, then freezes the selection. Batch capability is not a streaming session. VAD and audio endpoint sessions receive the same sequenced 16 kHz mono PCM as recognition. Their reset, gap and disposal lifetimes belong to the call.

Policy explicitly selects `local`, `hosted` or `provider`, with fallback `none` or `allowlisted`. The hosted factory cannot select legacy environment discovery. Every request, retry and fallback needs a fresh attempt grant. Registered reasoning endpoints declare their protocol, model, cancellation evidence and usage units; hosted connections use checked egress and sealed credential references. Neither an inline URL nor an environment key can override a hosted registration.

Memory adapters require scope and call identity on reads and writes. Conversation memory belongs to one call; cross-call retrieval is not enabled by these entry points. Shared model weights do not share prompts, credentials or inference state.

## Connection and playback

`VoiceCallManager` persists the call timeline and exactly one terminal event. `CallMinuteMeter` reports quantities and contains no price. A transport loss detaches the physical connection; a new authenticated epoch may reattach the same conversation within its bounds. A reconnect creates no fresh attempt allowance, reservation or duration budget. Stale worker, inference or transport generations cannot publish output.

The call profile requires awaited synthesis output. The playback queue counts decoded bytes and duration, including in-flight output, within its configured two-second ceiling. A successful socket send is not playback acknowledgement. Synthesis `flush_complete` does not end speaking until that generation's acknowledged queue drains. Interruption cancels model and tool work, cancels synthesis and clears playback before an old completion can affect the new generation.

`LiveKitStreamTransport` keeps listen-only construction. Speaking construction explicitly supplies its outbound publisher, which owns one track, conversion and acknowledged native cleanup. In native playout, the default, the track acknowledges each chunk by playing it out, so a phone caller bridged by LiveKit SIP or a plain LiveKit page hears the call and a clear needs no answer; participant playout keeps the receipt protocol for a page that asks for it ([Speaking in the room](VOICE_PIPELINE.md#speaking-in-the-room)). Raw PCM16 and declared WAV PCM16 are accepted at the publishing boundary; unsupported compression is refused, not interpreted as samples.

## Money and cleanup

The compound credit ledger in the safety runtime owns rate arithmetic, funding-lot allocation, customer and supplier holds, attempts, refunds and final settlement. Hosts provide immutable rates and policy. `ModelAttemptBudget` authorizes individual requests below routing and retry loops. Unknown final usage retains maximum liability until reconciliation; it is not zero usage.

Ending follows the manager's ordered cleanup hooks: stop admission and owned work, cancel synthesis and clear playback, drain permitted final transcripts, close media, confirm stop evidence, persist final quantities, release capacity and settle the reservation. A timeout or expired lease is a request to stop work, not proof that work stopped. Deferred holds remain committed across accounting windows until the required evidence arrives. Deletion records its journal tombstone before it revokes the content key, and a sealed restore reapplies every tombstone before surviving content is readable again.

See [Safety primitives](../safety/SAFETY_PRIMITIVES.md), [Voice pipeline](VOICE_PIPELINE.md), [Speech providers](SPEECH_PROVIDERS.md) and [Telephony providers](TELEPHONY_PROVIDERS.md). Phone carrier adapters retain their explicit compatibility profile and do not establish a production SIP or inbound-number service by themselves.

## Agency text listener

`agency({ voice: { enabled: true } }).listen()` is a loopback JSON-text convenience. Send `{ "text": "hello" }` and receive `{ "text": "reply" }`. It has no STT or TTS. Binary frames receive `{ "error": { "code": "audio_not_supported", "message": "This listener accepts JSON text only. Use VoiceSessionFactory for audio." } }` and close code 1003. A JSON audio envelope is invalid. Use the scoped factory and authenticated call transport for speech.

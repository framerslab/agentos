# Realtime Avatars

```typescript
import { readFile } from 'node:fs/promises';
import { SimliAvatarProvider } from '@framers/agentos/io/avatar';

const avatars = new SimliAvatarProvider({ apiKey: process.env.SIMLI_API_KEY! });

// Build a face from a portrait, then wait for it.
const job = await avatars.createFace(
  { data: await readFile('portrait.png'), mimeType: 'image/png' },
  { name: 'support-agent' },
);
let status = await avatars.faceStatus(job.faceId);
while (status.state === 'pending' || status.state === 'processing') {
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  status = await avatars.faceStatus(job.faceId);
}
if (status.state !== 'ready') throw new Error(`face build ${status.state}`);

// Mint a session for the face and hand the handle to the media plane.
const handle = await avatars.createSession({ faceId: job.faceId });
```

`@framers/agentos/io/avatar` animates a live, lip-synced talking head. It is a control plane: a provider builds faces and mints sessions, and the media plane joins a session with the handle the provider returns. Portrait generation lives elsewhere, in `io/media/avatar`.

## The provider seam

[`IAvatarProvider`](https://github.com/framerslab/agentos/blob/master/src/io/avatar/types.ts) is what every realtime-avatar provider implements:

| Member | What it does |
|---|---|
| `createSession(config)` | Mints a session for `config.faceId` and returns an `AvatarSessionHandle`: the session token, the ICE servers, and the audio contract (`pcm16` at `sampleRate` Hz). No media opens here. |
| `getIceServers()` | Fetches the ICE servers for the peer connection. |
| `createFace?(image, options)` | Uploads a portrait to build a new face. Resolves once the provider has accepted the build, with the new `faceId`. |
| `faceStatus?(faceId, options)` | Reads where one build stands: `pending`, `processing`, `ready`, `failed` or `not_found`. |

`createFace` and `faceStatus` are optional: a provider that cannot build faces leaves them out, so check for the method before calling it. A face that reads `ready` is a `faceId` for `createSession`.

[`AVATAR_PROVIDER_CATALOG`](https://github.com/framerslab/agentos/blob/master/src/io/avatar/providerCatalog.ts) lists each provider with its environment variables, media modes, audio contract and features. Simli is the one provider, unlocked by `SIMLI_API_KEY`, with the features `webrtc`, `lipsync`, `barge-in`, `sfu-relay` and `face-creation`.

## Media modes

| Mode | Who owns the peer connection |
|---|---|
| `client-delegated` | A browser SDK. The host forwards the `AvatarSessionHandle` to the client, and Node never touches WebRTC. |
| `server-driven` | Node. [`createSimliServerSession(handle, options)`](https://github.com/framerslab/agentos/blob/master/src/io/avatar/providers/SimliServerSession.ts) opens the peer through the optional `wrtc` native dependency, signals over Simli's WebSocket, and returns a `SimliServerSession` whose `sendAudio(chunk)` streams pcm16, `interrupt()` stops the avatar mid-sentence, `finish()` closes after the buffered audio plays and `close()` ends it at once. |

## Building a face

`createFace(image, options)` takes the image bytes as a `Uint8Array` (a Node `Buffer` included), an `ArrayBuffer` or a `Blob` (one from another realm, such as an iframe or jsdom, included), with an optional `mimeType` (default: the Blob's own type, else `image/png`) and `filename` (default `face.png`, `face.jpg` or `face.webp` by type). The bytes go to the provider as given: resize, crop or transcode the portrait to what the vendor takes before the call.

| Option | Meaning |
|---|---|
| `name` | A name the provider stores with the face. |
| `signal` | Aborts the upload. An abort while an error response is read rejects with the abort, not an `AvatarProviderError`. |
| `timeoutMs` | Upload deadline. Simli's default is 120000 ms. |
| `providerOptions` | Provider-specific. Simli sends `targetRatio` as the `target-ratio` header and every other key as a query parameter, such as `gsVersion`. |

The result, an `AvatarFaceJob`, carries `faceId`, the provider's `message`, its `warnings` about the image (the build goes ahead), `startAfterMs` when the provider holds the build before it starts, and the response body as `raw`.

`faceStatus(faceId, options)` returns an `AvatarFaceStatus`: `state`, the provider's own word for it as `providerState`, `queuePosition` (0 once the build is being worked on), `startAfterMs` for a held build, and `raw`. Its options are `signal` and `timeoutMs` (Simli's default: 10000 ms).

A vendor answer with an HTTP error status rejects with [`AvatarProviderError`](https://github.com/framerslab/agentos/blob/master/src/io/avatar/errors.ts), which carries `providerId`, `status` and the first 2000 characters of the response `body` (the rest is not read). Read the status to tell a refusal worth retrying later from a request the vendor cannot take:

```typescript
import { AvatarProviderError } from '@framers/agentos/io/avatar';

try {
  await avatars.createFace({ data: portrait });
} catch (error) {
  if (error instanceof AvatarProviderError && error.status === 403) {
    // Simli: the account has no avatars left for this gsVersion.
  } else {
    throw error;
  }
}
```

## Simli

[`SimliAvatarProvider`](https://github.com/framerslab/agentos/blob/master/src/io/avatar/providers/SimliAvatarProvider.ts) takes `apiKey`, `baseUrl` (default `https://api.simli.ai`) and `sampleRate` (default 16000). Every request carries the key in the `x-simli-api-key` header.

| Call | Simli endpoint |
|---|---|
| `createSession` | `POST /compose/token`, then `GET /compose/ice` |
| `getIceServers` | `GET /compose/ice` |
| `createFace` | `POST /faces/trinity`, multipart with the field `image`; `name` as the query parameter `face_name` |
| `faceStatus` | `GET /faces/trinity/generation_status?face_id=<faceId>` |

What Simli documents about face builds ([Generate Trinity Face](https://docs.simli.com/api-reference/generate-trinity-face), [Check Trinity Generation Status](https://docs.simli.com/api-reference/check-trinity-generation-status), [the OpenAPI document](https://api.simli.ai/openapi.yaml)):

- `gsVersion` is `GSA_2.0` (the default, a Trinity-2 face) or `GSA_1.0` (a Trinity-1 face, only on accounts created before October 26, 2026).
- An image that has not been through `POST /faces/trinity/preprocess` is framed by Simli first, which adds about 25 seconds to the upload. Pass the `TARGET-RATIO` header that preprocess returns as `providerOptions.targetRatio`, with the image it returned, to skip that step.
- One account's GSA_2.0 builds start at least 10 minutes apart. A build inside that window is accepted and held, and `startAfterMs` says until when.
- A 403 means the account is out of avatars for that `gsVersion`.
- `faceStatus` reads the entry of `generations` that names the face. Without one, it reads the top-level fields only when they name the face, or when nothing at all is listed; otherwise the face reads `not_found`.
- Simli's `completed` reads as `ready`. Completed and failed builds stay listed for 24 hours, so a face built longer ago reads `not_found`: record `ready` when you see it.

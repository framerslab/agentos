# Adding an LLM Provider

AgentOS dispatches across LLM providers through one interface. This guide covers when a new provider is worth adding, what you implement, and the bar a provider PR must clear. The bar is the same for every provider.

## Before you start: do you need a new provider?

Many services are OpenAI-compatible. If yours exposes an OpenAI-compatible `/chat/completions` endpoint, users can already reach it through the existing OpenAI-compatible path or through OpenRouter with no code change. Open an issue before writing a provider if you are unsure.

A dedicated provider is warranted when:

- The service has an official SDK or a stable, well-documented REST API.
- It is actively maintained and has a real user base, or a capability the existing providers do not cover.
- Its request and response shape needs handling the OpenAI-compatible adapter cannot express.

## What you implement

Concrete providers implement the [`IProvider`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/IProvider.ts) interface and live next to the others:

- Interface: [`/src/core/llm/providers/IProvider.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/IProvider.ts)
- Implementations: [`/src/core/llm/providers/implementations/`](https://github.com/framerslab/agentos/tree/master/src/core/llm/providers/implementations). Use `OpenAIProvider.ts` as the reference for OpenAI-shaped APIs, `OpenRouterProvider.ts` for an aggregator, and `GroqProvider.ts` or `TogetherProvider.ts` for OpenAI-compatible hosts.
- Registration and routing: [`/src/core/llm/providers/AIModelProviderManager.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/AIModelProviderManager.ts)
- Provider id, default model, and the env-var auto-detect order: [`/src/api/runtime/provider-defaults.ts`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/provider-defaults.ts)

Model your implementation on the closest existing provider rather than starting from scratch.

## Acceptance checklist

- [ ] Implements `IProvider` in full: text generation, streaming, structured output, and embeddings where the API supports them. Capabilities the API lacks fail clearly, not silently.
- [ ] Registered in [`AIModelProviderManager`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/AIModelProviderManager.ts) with a stable provider id.
- [ ] Default model and env-var detection added to `provider-defaults.ts`, placed in the auto-detect chain.
- [ ] Unit tests for request building, response parsing, and error mapping.
- [ ] Integration tests against the real API, mocked in CI. No live keys run in CI.
- [ ] Error-handling tests: auth failure, rate limit, malformed response.
- [ ] A streaming test if the API streams.
- [ ] Documentation: a short usage section and the default model.
- [ ] No new required dependency on the core. A provider SDK must be optional or a peer dependency, loaded lazily, so users who do not use the provider do not pay for it.
- [ ] A named maintainer. Provider integrations break when upstream APIs change, so each needs an owner. Name the owner in the pull request; the merging maintainer adds them to [`/.github/CODEOWNERS`](https://github.com/framerslab/agentos/blob/master/.github/CODEOWNERS) once they have write access to this repository.
- [ ] Conventional Commit title and green CI.

## Sponsorship and disclosure

Integration is free and open to any quality provider on technical merit. Partners and sponsors may also be featured prominently (top of the provider list, in examples, or with a partner badge), labeled as a sponsor or partner wherever they appear. See [`/SPONSORS.md`](https://github.com/framerslab/agentos/blob/master/SPONSORS.md).

Describe an integration as a "supported provider." "Partner" is a relationship claim, used where an agreement exists.

## Questions

Open an issue or email team@frame.dev before a large PR so we can agree on the approach.

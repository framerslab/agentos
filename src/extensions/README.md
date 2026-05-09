# extensions/

Extension system. Loader, manager, registry (per-kind descriptor stacks), shared service registry, manifest types, built-in packs. Implementations of individual extension packs (channels, guardrails, etc.) live in their own packages and load through this system at runtime.

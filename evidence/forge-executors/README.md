# Forged-code executor evidence

A CI job that measures an executor for forged code before the library offers effect capabilities (writes, deletes and state-changing requests), which it grants only on an executor that isolates. It answers five questions for QuickJS compiled to WebAssembly (`quickjs-emscripten` 0.32.0, which says of itself that it "has not been audited"), each against the library's in-process executor:

1. Can guest code await an asynchronous host function (`fetch`, `fs.readFile`)?
2. Do the forged tools in `tests/fixtures/forged-tools/` run on it, with the results the in-process executor gives?
3. What do start-up and each call cost?
4. What does its memory limit do when a guest exceeds it?
5. Does it stop a guest that yields once and then spins? (The in-process executor cannot: `node:vm`'s timeout covers synchronous time only.)

It also runs escape probes against the QuickJS executor directly, past the forge's validation.

| File | What it is |
|---|---|
| `run.ts` | The questions, the probes and the report |
| `quickjs-executor.ts` | A prototype `ForgedCodeExecutor` on QuickJS: a runtime and context per call, a memory limit, a stack limit, an interrupt at the deadline |
| `guest-surface.ts`, `guest-prelude.cjs` | How the granted functions reach the guest: host functions that take and return data only, and guest JavaScript that builds `fetch`, `fs.readFile`, `crypto` and the in-process context's built-ins over them |
| `in-process-child.ts` | One in-process case in a process of its own, for the cases that stall or exhaust the process running them |
| `package.json` | The run's one dependency, `quickjs-emscripten` 0.32.0, installed only by the job |

`.github/workflows/forge-executor-evidence.yml` runs the job on pull requests that touch the forge, the sandbox, this folder or the corpus, and on demand. It builds the library, installs this folder's dependency (`npm install --no-package-lock --ignore-scripts`), runs `run.ts`, writes the report to the job summary and uploads `out/` as the artifact `forge-executor-evidence`. A FAIL verdict does not fail the job; a harness error does.

Nothing here ships: the package publishes `dist`, `knowledge` and `README.md` only.

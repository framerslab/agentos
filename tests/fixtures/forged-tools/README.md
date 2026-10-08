# Forged-tool corpus

Forged tools as forging agents write them, each with the input it is called with and the result the in-process executor returns. Two sets:

- `library.json`: the forged code in the library's own forge tests, copied verbatim; `from` names the test file (and the test, where one test holds it). Captured on 2026-10-08 from master `06a8a96e`.
- `written.json`: tools written for this corpus: the computational models the example's departments are asked to forge (`examples/mars-genesis/shared/departments.ts`, `allowlist: []`), the language features and built-in globals such code uses, and each capability in the catalogue (`fetch`, `fs.read`, `crypto`).

Stored tools from consumer deployments: none were stored at capture (2026-10-08). No deployment had forging and storage both on.

`environment.ts` starts what the capability fixtures call, an HTTP server and a directory of files, and fills the placeholders in inputs:

| Placeholder | Becomes |
|---|---|
| `{{server}}` | `http://127.0.0.1:<port>` |
| `{{otherServer}}` | `http://localhost:<port>`: the same server under a host that a ceiling naming only `127.0.0.1` refuses |
| `{{root}}` | the directory holding `notes.txt` (`alpha`, `beta`, `gamma`, one per line) and `data.json` (`{"n":7,"tags":["x","y"]}`) |

The server answers `/json` (`{"items":[1,2,3],"source":"fixture"}`, `application/json`), `/status/404` (404, `missing`), `/headers` (`x-fixture: yes`, and the request's `x-request` echoed as `x-echo`) and anything else with `ok`.

Two readers use the corpus: `tests/emergent/forged-corpus.integration.spec.ts` runs every fixture on the in-process executor, and the executor evidence run (`evidence/forge-executors/`) runs every fixture on each executor it measures.

## Adding a fixture

Append an entry with a new `id`. `expect` is one of:

- `{ "success": true, "output": <value> }`: the output equals the value (deep, strict);
- `{ "success": true, "outputMatches": { "<key>": "<regex>" } }`: each named string field of the output matches;
- `{ "success": false, "errorIncludes": "<text>" }`: the call fails, and the error contains the text when one is given.

`timeoutMs` (default 5000) is the call's deadline; `note` says anything a reader needs. An entry whose `allowlist` names a capability runs under the ceiling `{ fetch: { domains: ['127.0.0.1'] }, 'fs.read': { roots: [<root>] }, crypto: {} }`, through the broker, with a call handle.

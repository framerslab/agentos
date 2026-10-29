# Study report: record-leg-2

> Record mode: replies come from the stub; quality numbers are mechanics only.

## 1. Run identity

Written 2026-10-28T16:33:16.132Z from the files the appendix lists; the generator calls no model.

Table: Run identity (source: results.json, calls.json, report-header.public.json)

| Field | Value |
|---|---|
| Study | gmi-vs-agent |
| Run | record-leg-2 |
| Mode | record |
| Task | T2 |
| Items | 1: item 1 |
| Arms | B, C0, C1 |
| Sample | 1 |
| C mode | warm |
| Outcome | completed |
| Subject | anthropic claude-haiku-4-5-20251001 |
| Vendors called | none: the stub answers every call (record mode) |
| agentos | 0.14.25 |
| Harness | agentos-bench, gmi-vs-agent family (unpublished), revision 8c0361f42073 |
| Runner | private runner at 2fdf749f5b55, CI run 40723979292 |
| Protocol | PROTOCOL-0a.md, SHA-256 10579b4e3eb9; addendum PROTOCOL-0a-addendum.md, SHA-256 684c21c83e02 |

## 2. The question

Does a GMI on the full AgentOS runtime improve companion-style, long-horizon conversation over the agent() loop the reference product runs, and at what cost in dollars and latency per turn?

B (the reference), C0 (the GMI) and C1 (the GMI with its sentiment presets, the candidate) decide it; every other arm is a control or a diagnostic. C minus B is what the GMI runtime adds over the reference product's agent()-based path, which builds the same memory manager; B minus A is what that memory layer and the product's assembly add to agent(), since A is agent() with the reference product's prompt and tools and no memory; C minus A is the sum of the two and is reported as a description (on T1 it is read as the memory wiring check, not as a runtime effect). A minus Z is what agent() with those tools, some of them inert, and its chain-of-thought block adds over one plain call, and Z is the floor every arm is read against.

The outcomes are GO, GO-COST, PORT, KILL, NOT SHOWN and NO VERDICT under the decision rules of the study's protocol (the Metrics and decision rules section of the study page, docs.agentos.sh/benchmarks/gmi-vs-agent). This report states what one run produced and applies no verdict rule.

## 3. The arms

Z is reported in every table and enters no decision rule. A minus Z, what agent() adds (its tools, the chain-of-thought block it prepends when tools are mounted, and its turn pipeline), is read on the A-against-Z pairs and the absolute scores. C against Z is read only on the absolute scores of the turns both arms ran, each arm on those turns alone (section 6); it is not measured on the axes judged only in pairs (better_reply, better_written), and no figure chains C minus A with A minus Z.

Table: The arms (source: results.json)

| Arm | Construction | In this run | Turns | Failed turns |
|---|---|---|---|---|
| B | The reference: the product's companion reply path as production runs it, driven by the private runner. | yes | 10 | 0 |
| C0 | A GMI on the full AgentOS runtime with B's model, memory configuration, system text per turn and tools. | yes | 10 | 0 |
| C1 | C0 with the shipped sentiment presets and two mood-keyed prompt elements: the candidate. | yes | 10 | 0 |
| B+S | B with one frozen sentence as system context: notice frustration or confusion, acknowledge it, change approach. | no | - | - |
| A | agent() with B's static system blocks, the turn's addon, B's tools and limits, and no memory. | no | - | - |
| A+gold | A with the gold evidence appended to the user turn (T1). | no | - | - |
| R | Bench retrieval over the ingested store, then a reader on the subject model (T1 anchor set). | no | - | - |
| Z | The bare loop: one streamed chat-completions call per turn over fetch, with A's model, A's static system blocks and the turn's addon, A's window and limits, and no chain-of-thought block, tools, memory or framework. | no | - | - |

## 4. Task families and item counts

Table: Task families and item counts (source: results.json)

| Task | Measures | In this run | Items | Turns |
|---|---|---|---|---|
| T1 | Recall: LongMemEval-S and LOCOMO questions asked after ingestion at the datasets' dates, graded per question. | no | - | - |
| T2 | Persona conversations: personality, responses and in-conversation memory, with callbacks, persona facts, false premises and in-fiction pressure. | yes | 1 | 10 |
| T3 | Sentiment adaptation: the replies after frustration and confusion cues, and false-positive scenes. | no | - | - |
| T4 | Text quality: single-turn prompts with frozen context and memory, judged in pairs. | no | - | - |

## 5. Metrics, judges and pins

not run: no judgment set given

Flags (persona-violation-v1, adaptation-v1, false-positive-v1): a judgment is the mean of the seats' hits, and an arm's figure is the mean over its judged replies. Grades (t1-grade, probe-grade): a judgment is 1 when the final grade is correct (J1 and J2 agree, else J3, else J1) and 0 otherwise.

Pairs (pairwise-reply-v1, pairwise-text-v1): side a scores 1 for a win, 0.5 for a tie and 0 for a loss on each vote, over both orders and both seats; a mean above 0.50 favours side a. Planted controls, calibration items and the A/A control are left out of sections 6 and 7.

Intervals: 95% percentile intervals of a cluster bootstrap with 10,000 resamples (clusterBootstrap), resampling cards (T1: the question's cluster from the T1 pack).

Judges are model seats pinned by engine, model and effort; a reply whose header names another seat, engine, model or effort is discarded, and the seat runner asks again. An engine that reports no served model writes the requested slug in its header, so the model of J1 is recorded as requested and unverified, and J1 is read through its planted controls and repeats.

## 6. Results per family

not run: no judgment set given (the absolute judgments)

Table: Turns and failures per arm (record mode: mechanics only) (source: results.json)

| Arm | Turns | Deadline | Error chunk | Memory missing | Not the subject model | Memory call error | Other |
|---|---|---|---|---|---|---|---|
| B | 10 | 0 | 0 | 0 | 0 | 0 | 0 |
| C0 | 10 | 0 | 0 | 0 | 0 | 0 | 0 |
| C1 | 10 | 0 | 0 | 0 | 0 | 0 | 0 |

Table: Probe exact matches per arm (T2's first pass) (record mode: mechanics only) (source: results.json)

| Arm | Probes scored | Exact | Share |
|---|---|---|---|
| B | 2 | 0 | 0.00 |
| C0 | 2 | 0 | 0.00 |
| C1 | 2 | 0 | 0.00 |

Table: Style rules kept per arm (T2) (record mode: mechanics only) (source: results.json)

| Arm | Rules checked | Kept | Share |
|---|---|---|---|
| B | 30 | 10 | 0.33 |
| C0 | 30 | 10 | 0.33 |
| C1 | 30 | 10 | 0.33 |

## 7. Pairwise verdicts

not run: no judgment set given

## 8. Cost per arm, tokens, cached tokens and the counterfactual

not run: record mode: the stub answers every call and prices none

## 9. Latency per arm

Nearest-rank quantiles of the seam's timings from each turn's start; a turn cut at the deadline ranks above every completed turn and reads "deadline" where it holds the rank. Completion is the turn's end after the runner's output guard. The post-turn wait is the time a C arm waits after its reply for the work the turn queued, read from its post-turn-wait event; an arm that records none reads "-". The study's latency ceilings read the first token's p50 and p95 and the last token's p95 against B.

Table: Latency per arm in milliseconds (record mode: mechanics only) (source: results.json)

| Arm | Turns | Deadlines | First token p50 | First token p95 | Last token p50 | Last token p95 | Completion p50 | Completion p95 | Post-turn wait p95 |
|---|---|---|---|---|---|---|---|---|---|
| B | 10 | 0 | 42 | 63 | 42 | 63 | 54 | 178 | - |
| C0 | 10 | 0 | 14 | 58 | 14 | 58 | 22 | 71 | 0 |
| C1 | 10 | 0 | 15 | 39 | 15 | 39 | 23 | 51 | 0 |

## 10. The determinism gate and the stability check

not run: no determinism record given (two record runs of one script compared by T5's gate)

not run: no judgment set given (the judging checks)

The runner's error rows: each turn's failure, a call left unanswered or answered with an error status, a call from another arm's key during a turn (checked on the run's own call log), and harness errors.

Table: Checks on this run (source: results.json)

| Check | Count |
|---|---|
| Stray connections | 0 |

## 11. The spend ledger

not run: no ledger given (a record run spends nothing)

## 12. Limitations

Record mode answers every call from the stub, so its quality figures measure the harness's mechanics and not the arms.

B runs in a private runner on the reference product's own code: section 3 describes its construction, and its code is not published. Every other arm's code is in the agentos-bench family, which is not published with this report.

Z is a control: a turn that needs a tool or a memory records Z's miss in the task's own measure, and Z enters no decision rule.

Judges are model seats; their verdicts are read through the planted controls and the judging checks, not taken as ground truth.

Intervals assume the clusters are independent; pairwise means pool both orders and both seats.

This report decides nothing: the analysis applies the decision rules of the study's protocol.

Deviation: Materials writer: Claude Code 2.1.289 with Claude Fable 5.1 at effort high, where the design named a Gemini model, which its client no longer offered on the day.

Deviation: Routing: the runner sends every vendor call of the reference arm to the stub or the metering proxy by rewriting the vendors' hosts inside its own process, since the reference product's calls take no base address of their own.

Deviation: The reference arm drives the product's streaming reply path, and its history is the last 50 stored messages the product reloads on every turn, where the other arms keep a window of 60.

Deviation: A GMI turn stops its tool loop at 5 model steps where the reference arm allows 12; the pilot report counts the reference arm's turns past 5 steps.

Deviation: The subject model was read from the reference product's reply records over the days they cover, a window shorter than the 30 days the design planned; every production setting along the reference arm's path is mirrored, beyond the list the design named.

## 13. Appendix: rubric hashes, materials provenance and the price table

not run: no judgment set given (the rubric hashes)

not run: no price table given (the day's prices)

No material excluded.

Table: Inputs (source: every file this report read)

| Input | File | SHA-256 |
|---|---|---|
| results | results.json | 897392635d1d5f88c3fb09b5149c7057cd7e3290f76bd1df83f7f3f8ce1add97 |
| calls | calls.json | 21a9cc2224f54f9f705496d473bccd9c825dbd5b15caa96b99a65049dd69882d |
| header | report-header.public.json | 0824c42b854b27dd5f7224a880bc97babebb159fe068ea8e2e36c98e218362ad |
| materials | BRIEF.md | 0984553b2f01690c6966e9af448cab652790f907cc235d62339c54dec9bea522 |
| materials | m01.prompt.md | c1f0dcd334483a5b6c8fd923ef68e238137d14c5f466331ae8b8d1a357b7e830 |
| materials | m01.reply.txt | 2a29ccdc1b87e1556178bb06ad4296f900406033374a5173f38a797924c97d16 |
| T1 pack | haystack 1 | a04ca369e5cab724ab65d7f85c16371bd0b93c5a46a360451828ce9afc841a49 |
| T1 pack | haystack 2 | 0bf5d2ff595e4791c0b02775c80fa7a0c2c3685c17a960627fbe21841b1e2577 |
| T1 pack | haystack 3 | c0cde690ee161dd86ec63bbcac75637ec3ce6d633c06c659534884ac80d4c0ad |
| T1 pack | haystack 4 | ebdd85f075360012569dd75c85874c04dc1adf6dc81fc243137e3a955e94c516 |
| T1 pack | haystack 5 | 673bc98414fc02481be70f4fcf6658136a1358b9f5a4945869f91722b4f24379 |
| T1 pack | haystack 6 | f2f08850af4a2b747483a5dd921af2b8a8ffc9c573cd3b74e822514b08412c99 |
| T1 pack | haystack 7 | db4b45823a155be77669fa5fbe5930a409a0bdbe068d8bf1400fd0fd1f1ad224 |
| T1 pack | haystack 8 | 89c082198e64aae4a3bbfefbf769b222733564bbce87158d1e2def45d319d2ef |
| T1 pack | haystack 9 | 90b3cfe022cf49ae69d4e925d2a636d4a07be9b7609c3c551e3fcfd0b509fcbf |
| T1 pack | haystack 10 | e647ec7ad89c528428c630dcea15c01341aca6aebc5304676c2222b71689141a |
| T1 pack | pack.json | 1085990f9b05ebfd35cdec94404a115e39d13ddc8b118a5f6ac7153e5885fde7 |

Table: Materials files (source: materials)

| Files | SHA-256 of the set |
|---|---|
| 3 | c0eb554ce1db87d06e3f0fab50cd7e4c2154b84aab9f0a17693fadd59a9387c4 |

Table: Materials batches (source: materials)

| Batch | Seat | Engine | Model | Effort | Items | Reply SHA-256 |
|---|---|---|---|---|---|---|
| m01 | M | claude-code 2.1.289 | claude-fable-5-1 | high | 40 | 2a29ccdc1b87e1556178bb06ad4296f900406033374a5173f38a797924c97d16 |

Table: T1 pack (source: T1 pack)

| File | SHA-256 |
|---|---|
| longmemeval-s source: longmemeval_s.json | 08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894 |
| locomo source: locomo10.json | 79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4 |
| haystack 1 | a04ca369e5cab724ab65d7f85c16371bd0b93c5a46a360451828ce9afc841a49 |
| haystack 2 | 0bf5d2ff595e4791c0b02775c80fa7a0c2c3685c17a960627fbe21841b1e2577 |
| haystack 3 | c0cde690ee161dd86ec63bbcac75637ec3ce6d633c06c659534884ac80d4c0ad |
| haystack 4 | ebdd85f075360012569dd75c85874c04dc1adf6dc81fc243137e3a955e94c516 |
| haystack 5 | 673bc98414fc02481be70f4fcf6658136a1358b9f5a4945869f91722b4f24379 |
| haystack 6 | f2f08850af4a2b747483a5dd921af2b8a8ffc9c573cd3b74e822514b08412c99 |
| haystack 7 | db4b45823a155be77669fa5fbe5930a409a0bdbe068d8bf1400fd0fd1f1ad224 |
| haystack 8 | 89c082198e64aae4a3bbfefbf769b222733564bbce87158d1e2def45d319d2ef |
| haystack 9 | 90b3cfe022cf49ae69d4e925d2a636d4a07be9b7609c3c551e3fcfd0b509fcbf |
| haystack 10 | e647ec7ad89c528428c630dcea15c01341aca6aebc5304676c2222b71689141a |
| pack.json | 1085990f9b05ebfd35cdec94404a115e39d13ddc8b118a5f6ac7153e5885fde7 |

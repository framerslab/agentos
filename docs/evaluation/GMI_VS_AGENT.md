---
description: "How AgentOS tests whether a GMI on the full runtime improves companion conversation over agent() and a bare model loop, and at what cost per turn."
---

# GMI versus agent() Study

This study compares a GMI on the full AgentOS runtime with the `agent()`-based reply path of a reference product, the companion chat of wilds.ai, on the same model. It reads both against `agent()` on its own and against a bare loop that calls the model with no framework. [Generalized Mind Instances (GMIs)](../GMI.md) describes what a GMI adds over a plain agent, and [Two API Paths](../API_PATHS.md) describes the runtime and the lightweight helper the arms are built on. This page sets out the study's design and lists the published reports. It states no measured number: every figure is in a report file.

Status: design published; protocol not yet registered; no report published.

## The question

Does a GMI on the full runtime improve companion-style, long-horizon conversation over the `agent()` loop the reference product runs, on memory, responses, personality and text, and at what cost in dollars and latency per turn?

The outcomes the protocol defines are product decisions for the reference product:

- **GO**: the candidate wins on at least one primary endpoint, loses on none, passes every validity gate and meets the cost and latency ceilings, and the win is attributed to the GMI. GO is the decision to build a GMI factory into the reference product and to move its companions behind a flag and a canary.
- **GO-COST**: every condition of GO holds except the cost or latency ceilings. The fix comes first; then one more set of tranches per task measures the winning endpoint and the cost again, and the outcome is GO if they pass and KILL if they do not.
- **PORT**: a part of the GMI reaches the gain when it runs around `agent()`. That part goes into AgentOS as an opt-in option, and no factory is built.
- **KILL**: no gain large enough to pay for a migration in the tested configuration. A primary endpoint that is worse and stays worse after one rerun is a KILL as well.
- **NOT SHOWN**: no KILL condition holds, and GO fails only because some endpoints are inconclusive. One extension runs, sized for those endpoints, and the outcome is then GO or KILL.
- **NO VERDICT**: a validity gate cannot pass within the spending ceiling.

An axis whose judges fail calibration reads "no verdict" and leaves the decision. A task left with one judge supports only KILL or NOT SHOWN on its judged endpoints.

## The arms

Three arms decide the question, and two controls are what the comparisons are read against:

| Arm | Role | Construction |
|---|---|---|
| B | the reference | The reference product's companion reply path, built on `agent()` with the product's own memory layer, driven in process with its production options by a private runner. |
| C0 | the GMI | A GMI on the full runtime, called through [`AgentOS.processRequest()`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts), with B's model, B's memory configuration, B's system text for the turn and B's tool definitions. |
| C1 | the candidate | C0 with the five shipped sentiment presets on and two mood-keyed contextual prompt elements that carry the presets' adjustments into the prompt. |
| A | control | [`agent()`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts) without `runtime: 'gmi'`, given the reference product's prompt and tools, with memory removed. |
| Z | control | The bare loop: one streamed chat-completions call per turn over `fetch`, with A's model, A's static system blocks and the turn's addon, A's window and limits, and no chain-of-thought block, tools, memory or framework. |

The other controls and diagnostics are A given the gold evidence (T1); R, the retrieval anchor, which runs the bench's retrieval over the ingested store and a reader on the subject model (T1); B with one frozen sentence that asks it to notice frustration or confusion, acknowledge it and change approach (T3); and two port arms, which run a part of the GMI around `agent()` (the GMI's rendered prompt and memory block, or a sentiment tracker and metaprompt executor in the host) on an endpoint the GMI wins.

What each comparison measures:

- C1 − B and C0 − B decide the question.
- C − B is what the GMI runtime adds over the reference product's `agent()`-based path, which builds the same memory manager.
- B − A is what that memory layer and the product's assembly add to `agent()`.
- C − A is the sum of the two and is reported as a description; on T1 it is the memory wiring check, not a runtime effect.
- A − Z is what `agent()` with the reference product's tools, some of them inert, and its chain-of-thought block adds over one plain call. The study does not separate `agent()`'s loop from those.
- Z is the floor every arm is read against. C against Z is read from absolute scores only: it is never judged in pairs, it is not measured on the pairwise axes, and it is never computed as C − A plus A − Z.
- Z and R vote in no decision rule.

## What every arm shares

Every arm calls one subject model, which every report names. The shared system text is the reference's static system blocks and the turn's addon, the reference's system text for that turn without its chain-of-thought block and its retrieved-memory section. What each arm adds to it or lacks:

- B sends its own system text, its chain-of-thought block and its retrieved-memory section included.
- C0 and C1 carry the chain-of-thought block of the reference's static base and their own memory, which the runtime places in the user turn; C1 adds its two mood-keyed prompt elements.
- A carries the chain-of-thought block `agent()` puts first when tools are mounted.
- Z receives the static blocks and the addon as one system message, with no chain-of-thought block.

Every arm runs under a 60-second wall deadline per turn, and a reply cut at the deadline is judged as it stands. Every arm has a 6,000-token output cap. One function sets the sampling and reasoning fields of every arm's main calls, at the stub or the metering proxy, to the values in the reference's captured request. The same output guard checks every arm's reply. Every arm but Z mounts the reference's tool definitions, and every arm with memory has a store of its own; Z has neither.

Two asymmetries are recorded and reported rather than removed:

- History: C, A and Z keep a 60-message window; B, driven as production runs it, reloads its last 50 stored messages on every turn.
- Tool steps: a GMI turn stops its tool loop at 5 model steps, where B allows 12.

## Task families

| Task | What it measures | Planning size | Arms |
|---|---|---|---|
| T0, retrieval parity | Evidence recall in the assembled context, B against C0, and ingestion equality on 5 T1 histories | embeddings only | B, C0 |
| T1, recall | Memory: questions asked after a conversation history is ingested at the dataset's own dates | all 500 eligible LongMemEval-S items [1] and 147 LOCOMO questions [2] | B and C0, C1 by reuse; A on 100 items, A with the gold evidence on the same 100, Z on A's 100, R on 60 |
| T2, persona conversations | Personality, responses and memory within a conversation: callbacks, persona facts, false premises and in-fiction pressure | 36 conversations of 30 turns | B, C0, C1; A and Z on the 12 multi-session conversations |
| T3, sentiment adaptation | Replies after frustration and confusion cues, and false-positive scenes | 48 scripts of 8 turns and 12 false-positive scenes | B, B with the frozen sentence, C0, C1; C0 and C1 also with a new GMI on every turn |
| T4, text quality | Single-turn replies with a frozen context and memory, judged in pairs | 180 single-turn prompts | B and C0, C1 by reuse; A and Z only when the revision after the pilot adds A |
| T5, cost and latency | Dollars and latency | every generated turn | every arm |

C1 runs its own turn every time. On a single-turn item its main request equals C0's whenever no preset has fired, so the proxy serves C0's reply to C1 once the volatile fields the harness lists are masked, and the reused pair counts once in the tests. The pilot revises these counts; the second protocol file, 0b, frozen after the pilot, fixes the final ones, and every report prints the counts its run used. The cards, scripts and contexts are written for the study, and no real user conversation is sent to any vendor.

## Metrics and decision rules

| Endpoint | What it measures | Task |
|---|---|---|
| R1 | Recall accuracy | T1, the LongMemEval-S items |
| P1 | Persona violation rate (lower is better) | T2 |
| Q1 | `better_reply` pair score | T2 and T3 |
| S1 | Adaptation pass rate | T3 |
| X1 | `better_written` pair score | T4 |
| G1, a guard | Callback accuracy | T2 |
| G2, a guard | Confabulation rate on false premises | T2 |

R1 is decided on LongMemEval-S alone. LOCOMO's ten conversations are too few clusters to pool, so LOCOMO is reported separately.

The statistics:

- Every comparison is paired within the item, with the arms' order seeded per item.
- Intervals come from a cluster bootstrap with 10,000 resamples [7]. The clusters are cards on T2 to T4, and on T1 the question's cluster: a LongMemEval-S question's own history, or a LOCOMO conversation.
- Superiority tests are one-sided, at α 0.015 at the full-sample look and 0.010 at the extension. Holm's procedure [6] runs across one family of ten tests: the five decision endpoints for C1 and for C0.
- An interim look at half the sample stops an axis for efficacy or harm at |z| ≥ 3.29, and for futility when the upper 95% bound sits below the sizing margin and the point estimate is at most 0.
- Pair scores are length-controlled: when the winning side's replies average 20% or more longer, a win counts only if it survives the length-controlled analysis.
- A blinded re-estimation after the first 100 T1 items and the first third of the T2, T3 and T4 items reads only nuisance parameters, never the arms' direction, and may only raise sizes.
- When sizes must shrink to fit the spending ceiling, scripts are dropped in an order fixed in the protocol that keeps every HEXACO extreme covered.
- A simulation of the whole decision rule, looks included, gives its operating characteristics before the confirmatory stage, against the targets P(GO | one endpoint better) ≥ 0.80 and P(GO | all equal) ≤ 0.05.

GO requires a win: at least one primary endpoint better, with both judges on the candidate's side, the sign kept when any one card is left out, and, for R1, the same sign on both datasets. It requires nothing else lost: every primary endpoint other than S1 non-inferior or better, S1, G1 and G2 not worse, and the arm's own failure rate within its limit. It requires every validity gate, the cost and latency ceilings, and the win's attribution to the GMI through the port arms and a pay test. The ceilings, C against B: mean dollars per turn at most 1.30 times B's; first-token latency at most B's plus 200 ms at the median and B's plus 500 ms at the 95th percentile; last-token latency at the 95th percentile at most 1.25 times B's; a failure rate at most 1 point above B's. GO-COST applies when only the ceilings are missed, and NO VERDICT when a validity gate cannot pass within the spending ceiling. A deadline, an error, a missing memory or a main reply not served by the subject model is a failure in that arm and counts as an outcome.

## Judges, calibration and the stability check

Two model judges from two vendors, J1 and J2, each pinned by engine, model and effort before the first confirmatory item and named in every report's pins table, judge the study's replies. A third grading pass, J3, settles a disagreement between J1's and J2's grades when their agreement falls below its bar. A named alternate replaces J1 only when J1 becomes unavailable, and then re-judges the whole task, since no judge is swapped inside a task. When no calibrated replacement is found, the task continues with one judge, and its judged endpoints can support only KILL or NOT SHOWN.

The judges are command-line model clients that answer prompt files CI writes; CI parses and scores the replies. The clients expose no temperature, so the harness measures each judge's stability by repeats. J1's client reports no served model, so J1's model is recorded as requested and unverified, and J1 is read through its planted controls and repeats.

- Judging is blind: arm codes are random, labels are swapped, and every pair is judged in both orders. No prompt names an arm, a GMI or `agent()`.
- Rubric versions are hashed, and every report prints the hashes.
- Planted controls calibrate each judge on each rubric before any confirmatory item is judged. A judge passes when it detects at least 0.90 of the strong controls and 0.75 of the mild ones, flags at most 0.15 of the clean items, gives the same verdict in both orders on at least 0.80 of the control pairs, and agrees with the other judge at κ ≥ 0.60 on flags and κ ≥ 0.40 on pairs.
- A seeded 10% of the judgments and every control are judged twice, and a judge must give the same verdict on at least 0.90 of the flags and 0.80 of the pairs. Both checks are read on every judging tranche, and a fall below either bar is treated as a judge that became unavailable.
- The A/A control judges each of B and C0 against a second sample of itself, on 30 prompts each.
- A judgment counts only with its full vote set: a pair with its four votes (two judges, both orders), a flag with both judges' answers, a repeated item with both repeats.

These choices answer known weaknesses of model judges: position, verbosity and self-enhancement biases [3], order effects that a balanced position calibration reduces [4], and evaluators that miss targeted quality drops [5]. The A/A control follows the A/A test of online controlled experiments [8].

## Metering and the spend ledger

Every model, embedding, rerank and guard call leaves the arms' process only through a local stub (record mode) or a metering proxy (live mode). The proxy prices each call from the day's price table, with cached and reasoning tokens, reserves the call's worst case before forwarding it, and closes it at 60 seconds. An arm's cost per turn includes every call its turn causes: the main call, sentiment scoring, metaprompts, memory calls, embeddings, reranks and the output guard. The one exception is a call that a turn cut at its deadline leaves running and that arrives during a later turn: it is charged to the arm whose turn runs when it arrives. Judging is not in the spend figures: the judge clients run at a flat rate, outside the ledger.

A durable ledger reserves each run's worst case before any spend and refuses a run that would pass the stage's cap. The live pilot's cap is $10. The confirmatory ceiling is set inside $500 to $1,000 from the pilot's measured unit costs, before the first confirmatory tranche, and it bounds the sample size, so every result states its endpoint's minimum detectable effect.

## The determinism gate

A record run made twice on the same inputs must send the same requests to the stub once the volatile fields the harness lists are masked. The process clock is pinned while a turn runs, to the dataset's date on T1, and latency is read from a monotonic timer. The gate covers every arm, Z included, and a live run starts only after it passes.

## Record mode

In record mode a local stub answers every call: the model list, canned replies by purpose, schema-valid metaprompt replies, 1,536-dimension character-hash embeddings, reranking by the same similarity, and delay and hang modes for the deadline. It needs no keys, and its runs are deterministic. Its suite checks that memory reaches C's requests and not A's; that the turn's addon reaches C and A; that no preset text is injected into C's prompt; that C carries no date tool; that history stays within 60 messages after 35 turns; that a frustrated turn fires one metaprompt in C1 and none in C0, and that C1's next request carries the matching prompt element; that a turn held at the stub past the deadline fails in every arm; and that the sampling rewrites reach main calls only.

Record mode runs in the project's CI on every change to the harness. Its reports measure the harness's mechanics, not the arms: each says so on its first page and marks every quality table. The harness code, the gmi-vs-agent family of the agentos-bench package, is not in the public agentos-bench repository and is not published, so this page gives no steps to run it elsewhere. The published record-mode report sets are listed under Reports and results.

## Live runs

Live runs are dispatched by hand from a workflow in the private runner's repository. The workflow runs in the `gmi-eval` environment, which holds the study's own vendor keys on prepaid balances with vendor-side limits, and it runs one study job at a time.

- A first job reserves the run's worst case on the `gmi-eval-ledger` branch before the job that holds the keys starts.
- A socket guard in the arms' process admits a vendor host only on the metering proxy's own connections and halts the run on any other.
- An operating-system rule on the runner refuses every connection the study's processes open other than loopback, name lookups and HTTPS, and logs refused connections and HTTPS connections to addresses no vendor host resolved to; the leg fails when the log holds either.
- A live run starts only after a record run of its legs logged no stray connection.

Judging: CI writes one prompt file per judgment, the judge clients answer them, the replies are committed to the `gmi-eval-judgments` branch, and CI parses and scores them. Outputs and reports go to the `gmi-eval-artifacts` branch. The three branches belong to the private runner's repository.

## Reading a report

A report has thirteen sections, in this order:

1. Run identity: the study, the run, the mode, the task, the items, the arms, the subject model, the AgentOS version, the harness revision, the runner's CI run and the protocol's SHA-256.
2. The question.
3. The arms, each with its construction, its turns and its failed turns.
4. Task families and item counts.
5. Metrics, judges and pins: the judgment sets, the judges' pins, the calibration axes and the A/A control.
6. Results per family: turns and failures per arm, the absolute judgments with their intervals, and C against Z on the items both ran.
7. Pairwise verdicts.
8. Cost per arm, tokens, cached tokens and the counterfactual.
9. Latency per arm.
10. The determinism gate and the stability check.
11. The spend ledger.
12. Limitations, with the deviations the protocol records.
13. Appendix: rubric hashes, materials provenance and the price table, with every input file and its SHA-256.

Every table names the files its figures come from. An input a run did not have reads "not run", never a number. A record-mode report says so on its first page and marks every quality table. A live pilot report says so on its first page with its item count, and marks its results, pairwise and latency tables. An interval over fewer than 5 clusters reads "too few clusters" with the count in place of its bounds. Intervals are 95% percentile intervals of a cluster bootstrap over cards (on T1, over the question's cluster), and a pair mean above 0.50 favours side a. The markdown, HTML and PDF files carry the same strings. A report states what one run produced and applies no decision rule.

## Reports and results

No report set is published.

No research paper is published.

## What the study does not cover

A result covers only the configuration measured: C1 with the five presets on and no trait adjustment, no retrieval augmentor and no RAG, the reference product's memory configuration and history window, the pinned AgentOS version, and the reference product's companions. `agent({ runtime: 'gmi' })` and `gmi()` are not arms. The study uses one subject model and materials written for it. Another product reruns the persona, sentiment and text tasks with its own setup before it acts on a result. Each report states whether B is the production path or the strongest lightweight configuration.

## Further reading

- [Generalized Mind Instances (GMIs)](../GMI.md): what a GMI holds and how a turn flows through it
- [Two API Paths](../API_PATHS.md): `agent()` and the full runtime
- [Evaluation Guide](../observability/EVALUATION.md): test cases, scorers, an LLM judge, run comparisons and reports in AgentOS
- [Memory Benchmarks](https://docs.agentos.sh/benchmarks): AgentOS's results on LongMemEval and LOCOMO

## References

1. Di Wu, Hongwei Wang, Wenhao Yu, Yuwei Zhang, Kai-Wei Chang and Dong Yu. LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory. ICLR 2025. [arXiv:2410.10813](https://arxiv.org/abs/2410.10813)
2. Adyasha Maharana, Dong-Ho Lee, Sergey Tulyakov, Mohit Bansal, Francesco Barbieri and Yuwei Fang. Evaluating Very Long-Term Conversational Memory of LLM Agents. Proceedings of the 62nd Annual Meeting of the Association for Computational Linguistics, 2024. [doi:10.18653/v1/2024.acl-long.747](https://doi.org/10.18653/v1/2024.acl-long.747)
3. Lianmin Zheng, Wei-Lin Chiang, Ying Sheng and others. Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena. NeurIPS 2023 Datasets and Benchmarks Track. [arXiv:2306.05685](https://arxiv.org/abs/2306.05685)
4. Peiyi Wang, Lei Li, Liang Chen and others. Large Language Models are not Fair Evaluators. arXiv preprint, 2023. [arXiv:2305.17926](https://arxiv.org/abs/2305.17926)
5. Sumanth Doddapaneni, Mohammed Safi Ur Rahman Khan, Sshubam Verma and Mitesh M. Khapra. Finding Blind Spots in Evaluator LLMs with Interpretable Checklists. EMNLP 2024. [arXiv:2406.13439](https://arxiv.org/abs/2406.13439)
6. Sture Holm. A simple sequentially rejective multiple test procedure. Scandinavian Journal of Statistics 6(2), 65-70, 1979. [JSTOR 4615733](https://www.jstor.org/stable/4615733)
7. C. A. Field and A. H. Welsh. Bootstrapping Clustered Data. Journal of the Royal Statistical Society Series B: Statistical Methodology 69(3), 369-390, 2007. [doi:10.1111/j.1467-9868.2007.00593.x](https://doi.org/10.1111/j.1467-9868.2007.00593.x)
8. Ron Kohavi, Diane Tang and Ya Xu. Trustworthy Online Controlled Experiments: A Practical Guide to A/B Testing, chapter 19, "The A/A Test", pp. 200-208. Cambridge University Press, 2020. [doi:10.1017/9781108653985.025](https://doi.org/10.1017/9781108653985.025)

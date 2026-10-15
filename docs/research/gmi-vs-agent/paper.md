---
title: "GMI versus agent(): a controlled comparison of an agent runtime, a lightweight agent loop and a bare model loop in long-horizon companion conversation"
author: "The AgentOS project"
date: "2026-10-12"
status: "draft: method only; results pending"
---

## Abstract

Agent frameworks wrap a model call in persona state, long-term memory, mood tracking and self-directed prompts. Whether those layers improve a product's conversation over a plain agent loop, and at what cost per turn, is a question that memory benchmarks do not answer on their own. This study compares a Generalized Mind Instance (GMI) on the full AgentOS runtime with the `agent()`-based reply path of a reference product, the companion chat of wilds.ai, on one subject model. The decided contrasts are C1 − B and C0 − B: the GMI with its sentiment presets (C1) and the GMI alone (C0) against the reference (B). Two controls frame them: `agent()` with the reference product's prompt and tools and with memory removed (A), and a bare loop that calls the model with no framework (Z); further arms serve as diagnostics. The tasks cover long-term recall on LongMemEval-S and LOCOMO, persona conversations, sentiment adaptation, text quality, and cost and latency. Two model judges from two vendors judge blind and in both orders, calibrated on planted controls, with stability repeats and an A/A control. The analysis pairs the arms within items, draws cluster-bootstrap intervals and applies Holm's correction across ten tests. Spending is staged: a $10 pilot, then a confirmatory ceiling set from the pilot's measured unit costs. This draft states the method; the results are pending the confirmatory analysis.

## 1. Introduction

Agent frameworks add persona state, memory, mood tracking and self-directed prompts around a model call. Memory benchmarks measure whether an assistant recalls what it was told over long conversations [1, 2], and agent architectures add memory tiers managed by the model, memory streams with reflection, and cognitive frameworks for memory and action [3, 4, 5]. Whether these layers improve a product's conversation over a plain agent loop, and at what cost per turn, is a product question that recall alone does not answer. A companion's reply is read for what it remembers, for whether it stays in character, for how it meets a user's frustration or confusion, and for how it is written, and every layer adds calls, tokens and latency to the turn.

AgentOS offers [two paths to a model](../../API_PATHS.md). `agent()` is a lightweight loop over the system text, tools and history its host passes. `AgentOS.processRequest()` runs the full runtime, where a [GMI](../../GMI.md) holds a persona, cognitive memory, metaprompts, sentiment tracking and contextual prompt elements (Section 2). The reference product of this study, the companion chat of wilds.ai, answers its users through `agent()` with a memory layer of its own.

The question is whether a GMI on the full runtime improves the reference product's companion conversation on memory, responses, personality and text, and at what cost in dollars and latency per turn. Each outcome is a product decision for the reference product. GO is the decision to build a GMI factory into it and to move its companions behind a flag and a canary. GO-COST holds every condition of GO except the cost or latency ceilings, and puts a cost fix and one more measurement before the decision. PORT moves the part of the GMI that carries the gain around `agent()` as an opt-in AgentOS option. KILL finds no gain large enough to pay for a migration in the tested configuration. NOT SHOWN leaves some endpoints inconclusive, runs one extension and then decides GO or KILL. NO VERDICT is the outcome when a validity gate cannot pass within the spending ceiling. An axis whose judges fail calibration gets no verdict, and a task left with one judge supports only KILL or NOT SHOWN on its judged endpoints.

The study makes four contributions:

1. A comparison against the reference product's own reply path, run in process as production runs it, with `agent()` without memory and a bare model loop as controls; the bare loop is the floor every arm is read against (Section 4.1).
2. A harness through which every model, embedding, rerank and guard call passes a local stub or a metering proxy, with a determinism gate and a durable spend ledger (Section 4.8).
3. Judging calibrated on planted controls, with stability repeats and an A/A control (Section 4.5).
4. A dated commitment: the SHA-256 of the private protocol appears on the public [study page](../../evaluation/GMI_VS_AGENT.md) before any paid call, where an auditor given the file can check it, and the page's dated method is the public record of the design (Section 4.9).

The scope is narrow by design: one configuration, one subject model and one product (Section 8).

## 2. Background

### 2.1 Two paths in AgentOS

`agent()` builds a lightweight agent. It calls the model with a system prompt built from the host's instructions and personality values, keeps a session's messages in process memory, and runs the tools the host lists; without `runtime: 'gmi'` it creates no GMI. `AgentOS.processRequest()` hands each request to the GMI bound to the request's session. The GMI holds that session's persona, working memory, conversation history, mood, user and task context, and a reasoning trace, and it runs the turn: retrieval, prompt construction, the streamed model call and the tool calls the model makes. The AgentOS guides [Two API Paths](../../API_PATHS.md) and [Generalized Mind Instances](../../GMI.md) describe both paths, with links to the source of [`agent()`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts) and [`AgentOS.processRequest()`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts).

### 2.2 The parts the study exercises

Cognitive memory encodes, decays and retrieves memory traces, with an Ebbinghaus forgetting curve as its base decay model; when the host configures them, eight further mechanisms act on the traces, and all but one scale with the persona's HEXACO trait values ([Generalized Mind Instances](../../GMI.md), "Cognitive memory"). HEXACO is a six-factor model of personality structure: honesty-humility, emotionality, extraversion, agreeableness, conscientiousness and openness to experience [7]. Cognitive memory's division of episodic, semantic and procedural memory follows CoALA [5], and the combination of persona, memory and reflection in one agent follows generative agents [4]. On a GMI turn the runtime places the retrieved memory block before the user's message, as `Context: ... User Query: ...`, rather than in the system prompt ([`PromptEngine.ts`](https://github.com/framerslab/agentos/blob/master/src/core/llm/PromptEngine.ts)).

Metaprompts run after a reply, on events and on turn intervals. The five shipped sentiment presets, frustration recovery, confusion clarification, satisfaction reinforcement, error recovery and engagement ([`metaprompt_presets.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/personas/metaprompt_presets.ts)), attach metaprompts to the sentiment events that a utility model raises from each user turn ([`SentimentTracker.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/SentimentTracker.ts)). A metaprompt's reply can change the GMI's mood, the user's skill level, the task's complexity and working-memory entries ([`MetapromptExecutor.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/MetapromptExecutor.ts)). That state reaches the next prompt in two ways: contextual prompt elements whose criteria match it, by mood, skill level or task complexity, add their text, and the GMI encodes and recalls memory traces with its current mood, so a change of mood can change which traces retrieval returns ([`CognitiveMemoryBridge.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/CognitiveMemoryBridge.ts)). With no such element, a firing reaches the prompt only through that weighting of memory. This is why the candidate arm carries two elements of its own (Section 4.1).

### 2.3 The reference product

The reference product's companion reply path calls `agent()` with a memory layer of its own, which builds the same AgentOS cognitive memory manager the GMI runs. The study drives that path in process with its production options from a private runner, so the reference is the product as it runs and not a reimplementation of it (Section 4.1).

## 3. Related work

### 3.1 Long-term conversational memory

LOCOMO collects very long dialogues, about 300 turns and 9K tokens on average over up to 35 sessions, and measures memory with question answering, event summarization and multimodal dialogue generation [1]. LongMemEval embeds 500 questions in chat histories of scalable length and tests five abilities: information extraction, multi-session reasoning, temporal reasoning, knowledge updates and abstention [2]. An independent audit of LOCOMO reports 99 of its 1,540 questions with wrong golden answers, and a model judge that accepted 62.81% of intentionally wrong, vague but topical answers [8]. Memory layers built for agents report on these benchmarks [9, 10]. The study draws stratified T1 items from both datasets, decides its recall endpoint on LongMemEval-S alone and reports LOCOMO separately (Section 4.3).

### 3.2 Memory-augmented agents

MemGPT manages memory tiers to give a model context beyond its window, with interrupts to manage control flow [3]. Generative agents keep a complete record of experience in natural language, synthesize it into reflections and retrieve it to plan [4]. MemoryBank forgets and reinforces memories along the Ebbinghaus forgetting curve, and applies them in a long-term companion [11]. CoALA describes language agents as cognitive architectures with modular memory, a structured action space and a decision process [5]. A GMI combines elements of each; the study asks whether the combination pays for itself in one product.

### 3.3 Persona and affect

PersonaGym evaluates persona agents across environments with a decision-theoretic score [12]; CharacterEval, a Chinese benchmark, evaluates role-playing conversational agents on thirteen metrics in four dimensions [13]; and EmpatheticDialogues grounds dialogue in emotional situations [14]. The study measures persona violations on cards written for it, and adaptation to frustration and confusion cues (Section 4.3).

### 3.4 Model judges

Model judges show position, verbosity and self-enhancement biases, while strong judges reach over 80% agreement with human preferences [6]. The order in which two answers appear can change a judge's verdict, and aggregating over both orders calibrates for it [15]. Position bias varies across judges and tasks, and is described by repetition stability, position consistency and preference fairness [16]. Evaluator models can recognize their own generations, and their preference for them grows with that ability [17]. A regression that predicts a judge's preference at zero length difference controls its preference for longer outputs [18]. Further studies catalogue judge biases [19, 20, 21], measure judges' alignment with human graders and find a tendency toward leniency [22], and benchmark judges on hard response pairs [23]. Targeted perturbations show that evaluator models miss the quality drop in over half of the cases on average [24].

Each finding has an answer in the design (Section 4.5): both orders and swapped labels for order effects; two judges from two vendors for self-preference; length control as a validity gate for verbosity; planted controls built by perturbation for blind spots; stability repeats for inconsistency; and complete vote sets, so that no judgment counts on a partial verdict.

### 3.5 Statistics and registration

Holm's procedure tests several hypotheses in sequence and controls the family-wise error rate [25]. Resampling whole clusters gives consistent variance estimates under both the random-effect and the transformation models of clustered data [26]. Evaluations of language models are experiments: when their questions come in clusters, a naive standard error is inconsistent and a clustered one replaces it, and when two models answer the same questions, a paired analysis reduces the standard error (sections 2.2 and 4.2 of [27]). Defining the research questions and the analysis plan before observing the outcomes separates the analyses that test predictions from those that generate them [28]. Running A/A tests is part of establishing trust in an experimentation platform, and such tests fail often in practice, which leads to re-evaluating assumptions and finding bugs (chapter 19 of [29]); the study's A/A control applies the idea to its judges (Section 4.5).

## 4. Method

### 4.1 Arms

**B, the reference.** The reference product's companion reply path, constructed on every turn as the product's chat endpoint constructs it on its main path, with the options recorded from that endpoint and the subject model as the endpoint sets it. Its history, relationship state, mood and message count come from the arm's own store and are reloaded on every turn as the endpoint reloads them, and its memory layer writes to an account of its own. B is not changed: a private runner drives the product's code in process.

**C0, the GMI.** `AgentOS.processRequest()` in process, on a runtime created with the subject model, personas defined inline, turn planning off, and no conversational persistence or automatic summarization, so that the persona's 60-message window is the prompt history. A cognitive memory factory returns a manager built by the same construction as B's, on C's own account; a turn whose GMI has no memory manager, or that shows no memory read, fails. The persona's base system prompt is B's static base, which carries the card's traits as the reference product renders them (Section 5.3); its personality traits are the card's six HEXACO values, recorded and not rendered by the GMI; and its model is pinned. The runtime's prompt profile has one entry, whose add-on text the runner sets before each C turn to B's per-turn addon: B's system text for that turn without its static base and without its retrieved-memory section. The GMI adds that text as a system prompt of the turn. C0 mounts B's tool definitions with implementations over its own stores, has the runtime's date tool removed, and runs no sentiment tracking, no metaprompts and no retrieval augmentor.

**C1, the candidate.** C0 with the five shipped sentiment presets on and two contextual prompt elements of type `system_instruction_addon`: one with the criterion `mood: 'empathetic'`, the mood the frustration preset's prompt proposes, and one with `mood: 'analytical'`, the confusion preset's. A firing sets the mood its metaprompt's reply names, when the reply names one of the GMI's moods, so an element adds its text only while the GMI holds that element's mood. Each element carries the frozen sentence of the B-with-sentence arm below, split by state, so that C1 against that arm tests the GMI's gating rather than the wording. C1 runs its own turn every time, so its sentiment scoring, metaprompt calls and latency are metered. A record-mode gate runs before any spend: on the turn after a firing, C1's main request must differ from C0's by exactly the element's text. If the gate fails, C1 is dropped before any spend and C0 becomes the candidate.

**A, `agent()` without memory.** [`agent()`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts) without `runtime: 'gmi'`, given B's static system blocks, the turn's addon appended before generation, B's tool definitions with implementations over A's own stores, a chain-of-thought block, an output cap of 6,000 tokens and a 60-second duration limit, with its history reseeded from the script and no memory. On T1, A also runs as the oracle arm, with the gold evidence appended to the user turn.

**Z, the bare loop.** One streamed chat-completions call per turn over `fetch`, to the root every arm's main calls reach (the stub in record mode, the metering proxy in live mode): the subject model; one system message holding B's static blocks joined with a blank line, then the turn's addon; A's 60-message window over Z's own transcript, ending with the user turn; and an output cap of 6,000 tokens. Z has no tools, no memory, no metaprompts, no chain-of-thought block and no AgentOS module. A call that fails before any text is sent again at most twice, and never past the deadline. With an Anthropic subject, Z reaches the model through Anthropic's OpenAI-compatible endpoint, which hoists system messages into one system field joined with a single newline, ignores `reasoning_effort` and supports no prompt caching [30]. A probe on the day of a live run sends an invalid value of each sampling field on that route and expects a refusal for each; when the route ignores a field, Z speaks the vendor's Messages API for the run, and the report records the deviation.

**The other arms.** R, the retrieval anchor, runs the bench's retrieval over the ingested store and then a reader on the subject model, on 60 T1 questions. B with one frozen sentence (notice frustration or confusion, acknowledge it, change approach) runs on T3. The port arms run only on an endpoint the GMI wins: on T4, `agent()` given C0's captured system text and memory block item by item; on T2 and T3, `agent()` with the host assembling the GMI's memory context and persona rendering; and a host-side sentiment tracker and metaprompt executor around `agent()` over B's prompt. B′ and C0′, second samples of B and C0, form the A/A control. C0 and C1 also run T3 in a cold-session mode, with a new GMI on every turn and the history hydrated from the arm's own transcript.

**Order within a turn.** B runs first, since its system text feeds C; then C0; then C1, whose reuse reads C0's request; then the task's other arms, in an order seeded per item.

**What each contrast measures.** C1 − B and C0 − B decide. C − B is what the GMI runtime adds over the reference product's `agent()`-based path, which builds the same memory manager. B − A is what that memory layer and the product's assembly add to `agent()`, since A is the reference product's prompt and tools on `agent()` with memory removed. C − A is the sum of the two and is reported as a description; on T1 it is read as the memory wiring check, not as a runtime effect. A − Z is what `agent()` with the reference product's tools, some of them inert, and its chain-of-thought block adds over one plain call; the study does not separate `agent()`'s loop from those. Z is the floor every arm is read against. C against Z is read only on absolute scores, on the items both arms ran, each arm's score taken on those items alone: it is never judged in pairs, it is not measured on the axes judged only in pairs, and it is never computed as C − A plus A − Z. Z and R vote in no decision rule.

### 4.2 Parity

Every arm calls the subject model. The shared system text is B's static system blocks and the turn's addon. B, C and A carry a chain-of-thought block: B its own, C inside its base system prompt, and A the block `agent()` puts first when tools are mounted; Z carries none. C places its memory in the user turn, as the runtime formats it; A and Z have no memory; C1 adds its two prompt elements. Every arm but Z mounts B's tool definitions with implementations over the arm's own stores; a tool whose production implementation is outside the study's reach returns the production "unavailable" answer, and every call to it is reported as a deviation.

Every arm runs under one 60-second wall deadline per turn, enforced at the seam the arms share, with an output cap of 6,000 tokens. A turn cut at the deadline is a failure in that arm, its text is judged as it stands, and it ranks above every completed turn in the latency percentiles. One function sets the sampling and reasoning fields of every arm's main calls, at the stub or the proxy, to the values in B's captured request; metaprompt, memory, guard and embedding calls are never rewritten. The same output guard checks every arm's reply. A main reply not served by the subject model is a failure in that arm.

Two asymmetries remain and are reported. B, driven as production runs it, reloads its last 50 stored messages on every turn, against the 60-message window of C, A and Z. A GMI turn stops its tool loop at 5 model steps, against B's 12; the pilot counts B's turns past 5 steps. The arms' prompt-cache layouts also differ: B sends its system blocks with one-hour cache marks, C sends one system string with a request-level mark, and Z sends no mark. C0 and C1 share prefixes and C1 runs right after C0, so C1's cache reads are reported as a covariate.

### 4.3 Tasks

| Task | Measures | Planning items | Arms |
|---|---|---|---|
| T0, retrieval parity | Evidence recall in the assembled context, B against C0; ingestion equality on 5 T1 histories | embeddings only | B, C0 |
| T1, recall | Memory | all 500 eligible LongMemEval-S items [2] and 147 LOCOMO questions [1] (at most 3 per category and conversation) | B and C0, C1 by reuse; A on 100; A with the gold evidence on the same 100; Z on A's 100; R on 60 |
| T2, persona conversations | Personality, responses and memory within a conversation | 36 conversations of 30 turns | B, C0, C1; A and Z on the 12 multi-session conversations |
| T3, sentiment adaptation | Responses after frustration and confusion cues | 48 scripts of 8 turns and 12 false-positive scenes | B, B with the frozen sentence, C0, C1; C0 and C1 also in cold-session mode |
| T4, text quality | Text | 180 single-turn prompts | B and C0, C1 by reuse; A and Z only when the revision after the pilot adds A |
| T5, cost and latency | Dollars and latency | every generated turn | every arm |

T1 draws its items from both datasets with a seeded draw stratified by question type and category. Each arm ingests a question's history with its own memory manager at the dataset's timestamps, and each question reads a copy of the store as it stood after ingestion, opened fresh, with the process clock pinned to the question's date. A judge from a vendor other than the subject's grades T1 answers with LongMemEval's grading prompts, chosen by question type [2], and the second judge regrades a seeded 20%. A LOCOMO question takes the prompt of the nearest type: a temporal question the temporal-reasoning prompt, an adversarial question the abstention prompt, and every other question the multi-session prompt. R1 is decided on LongMemEval-S alone: LOCOMO's 10 conversations are fewer than the 30 clusters pooling requires, so LOCOMO is reported separately and read for the same-sign condition of Section 4.4.

T2 holds three scripts for each of twelve cards: one session of small talk and advice; three sessions of ten turns, with the history and the conversation reset at each break and the memory kept; and one session of emotional support. User turns never adapt to the replies. Each script holds 5 callbacks (a fact given at turns 1 to 8 and asked at turns 21 to 29), 3 persona-fact questions, 2 false premises and 3 in-fiction pressure probes, at positions fixed in a frozen grid that avoids the pairwise turns 5, 10, 15, 20, 25 and 30. With a 60-message window a 30-turn single session stays inside the window, so its callbacks measure in-context recall; callbacks past the window happen only across the multi-session breaks, and the secondary "past the window" breakdown reports those alone.

T3's 48 scripts are 24 frustration and 24 confusion scripts, each set split into 8 explicit, 8 implicit and 8 sarcastic; each card plays 4 scripts. The cues fall at turns 3 and 5, and the judged replies are turns 3 to 6. A metaprompt runs after the reply of the turn that fired it, so C1 can differ from C0 only from the turn after a firing: turns 4 and 6 carry C1's adaptation and are reported separately as a secondary. The 12 false-positive scenes (grief roleplay, dark fiction, venting about a third party) check that a reply does not treat the user's feeling as the companion's fault or break the scene.

T4's 180 prompts are 15 per card: 3 casual, 3 emotional support, 3 roleplay continuations, 2 in-character questions, 2 advice, 1 creative and 1 out of scope. Each has a frozen context of up to 6 messages and a seeded 20-fact memory, written with the other materials (Section 5.3) and identical across arms.

The pilot revises the planning counts, and 0b fixes the final ones (Section 4.9); every report prints the counts its run used.

### 4.4 Endpoints and decision rules

| Endpoint | Measure (C − B unless stated) | Task and planning data | Sizing margin | Non-inferiority margin |
|---|---|---|---|---|
| R1 | Recall accuracy | T1, at least 500 pairs | +5 points | −5 points |
| P1 | Persona violation rate, B − C (lower is better) | T2, 324 flagged replies per arm | 5 points fewer | −5 points |
| Q1 | `better_reply` pair score | T2's 216 and T3's 192 pairs, 408 in all | 0.58 | 0.42 |
| S1 | Adaptation pass rate | T3, 192 replies per arm | +15 points | none: superiority only, and S1 must not be WORSE |
| X1 | `better_written` pair score | T4, 180 pairs | 0.58 | 0.42 |
| G1, guard | Callback accuracy | T2, 180 per arm | none | must not be WORSE |
| G2, guard | Confabulation rate on false premises, B − C (lower is better) | T2, 72 per arm | none | must not be WORSE |

If T1 cannot run as designed and becomes report-only, G1 takes R1's place as the memory endpoint: it becomes a primary endpoint in the decision rules and in the family of ten tests (Section 4.6), with a sizing margin of +10 points and a non-inferiority margin of −10 points.

All tests are one-sided, on each endpoint's measure as the table orients it, so that a positive value favours the candidate (P1 and G2 read B − C). BETTER: the lower confidence bound of the measure is above 0, or above 0.5 for a pair score. NON-INFERIOR: the lower bound is above the non-inferiority margin, a bound on the measure as the table orients it: −5 points for R1, −5 points for P1 (a violation rate at most 5 points above B's), and 0.42 for a pair score. WORSE: the unadjusted two-sided 95% upper bound is below 0, or below 0.5 for a pair score. The margins size the study, and the verdicts read the bounds. A BETTER verdict on a judged endpoint also requires each judge's own mean to sit on the candidate's side.

**GO** requires (a) a win: at least one primary endpoint BETTER for the candidate, with both judges on C's side on a judged endpoint, the sign kept when any one card is left out, the win surviving validity gate V8, and, for R1, the same sign in both datasets; (b) nothing else lost: every other primary endpoint but S1 NON-INFERIOR or BETTER, S1, G1 and G2 not WORSE, and the arm's own failure rate within its ceiling; (c) every validity gate of Section 4.7, where an axis whose judges fail calibration is reported as "no verdict" and leaves (a) and (b); (d) the cost and latency ceilings; and (e) attribution of the win to the GMI, with a pay test that passes.

**GO-COST**: (a), (b), (c) and (e) hold and (d) is missed. The cost or latency fix comes first, then one re-measure tranche set per task covers the winning endpoint and the cost: GO if it passes, KILL if it fails. When C misses the cost ceiling and a caching counterfactual would meet it, the outcome is GO-COST. The counterfactual reprices each of C's main calls as if its static prefix (the tool block and the static system base, sized by the median of B's main-call cache reads) were cached, moving to the cache-read rate only the part the call did not already read, and pricing at the write rate B paid on as many of C's main calls as B's main calls wrote the prefix.

**PORT**: (a) to (c) hold, and a port arm reaches the gain: the best port arm is non-inferior to C1, or, for the port arm that gives `agent()` the GMI's rendered prompt and memory, the lower bound of (port − B) − ⅔(C1 − B) is above 0. The component goes into AgentOS as a published opt-in option, and no factory is built.

**KILL**: a primary endpoint is WORSE and stays WORSE after one matched-configuration rerun, allowed only when the logs trace the loss to a default; no endpoint is BETTER and every upper bound sits below its sizing margin; no endpoint is BETTER after the full sample and the extension; the cost exceeds twice B's with fewer than two BETTER endpoints; or a GO-COST re-measure fails.

**NOT SHOWN**: no KILL condition holds, and GO fails only because some endpoints are inconclusive. One extension runs, sized for each inconclusive endpoint by the simulation of Section 4.6 and kept within the ceiling; afterwards the outcome is GO if its conditions hold and KILL otherwise.

**NO VERDICT**: a validity gate cannot pass within the spending ceiling. A task left with one judge supports only KILL or NOT SHOWN on its judged endpoints (Section 4.5).

The ceilings, C against B: mean dollars per turn at most 1.30 times B's, with every call a turn causes charged to it; first-token latency at most B's plus 200 ms at the median and B's plus 500 ms at the 95th percentile; last-token latency at most 1.25 times B's at the 95th percentile; and a failure rate attributable to the arm at most 1 point above B's. A deadline, an error, a missing memory or a main reply not served by the subject model is a failure in that arm. C1's first token follows its utility model's sentiment call, so every tranche reports that call's share of C1's first-token and last-token latency, and the attribution names it whenever C1 misses a latency ceiling.

Attribution: the port arms run only on an endpoint C wins, on its full paired set. For a win to count toward GO, the candidate must beat the best port arm under the same superiority test; when the candidate is C1, C1 − C0 must also be above 0 on that endpoint, so that part of the win comes from what only the GMI supplies, and a win on text alone cannot meet this, since C1 reuses C0's reply on single turns. A pay test, written down before any GO, compares the hours of a migration with the hours of a port.

Candidate order: C1 is evaluated first. When C1 does not reach GO, C0 is evaluated under the same rules within the same ten-test family. When the record-mode gate drops C1, C0 is the candidate, S1 becomes descriptive and the cost rows use C0. After T2 completes, every endpoint it produces is evaluated for both candidates, and a failure no later result can reverse is a KILL that stops spending. The cold-session reading of S1 and C1's turns after a trigger are secondaries planned in advance.

### 4.5 Judges, rubrics and calibration

Two model judges from two vendors, J1 and J2, judge the replies. Each is pinned by engine, model and effort before the first confirmatory item and named in every report's pins table. A third grading pass, J3, settles a disagreement between J1's and J2's grades when their agreement falls below its bar: on T1, at 30 double-graded answers and again at the end, a κ below 0.80 or a raw agreement below 95% sends every B and C answer to both graders and every disagreement to the third pass. A named alternate replaces J1 only when J1 becomes unavailable, and then re-judges the whole task, since no judge is swapped inside a task.

The judges run as command-line model clients: CI writes one prompt file per judgment, the clients answer the files, and CI parses the replies and scores them. The clients expose no temperature, so the harness measures each judge's stability by repeats instead of setting it. J1's client reports no served model, so J1's model is recorded as requested and unverified, and J1 is read through its planted controls and repeats. A reply whose header names another engine, model or effort is discarded and asked again.

A judge sees the persona card and the scripted user turns, each side's own earlier replies (which swap with the labels), the gold fact on callback turns, and the final text of the replies with whitespace normalized, labelled "Reply 1" and "Reply 2". It sees no arm name, and no prompt mentions GMIs or `agent()`. Arm codes are random and drawn again at every stage, and only the committed analysis opens the mapping.

The rubrics (version 1, each hashed): persona-violation-v1 flags a reply that contradicts a card fact, shows a trait in the wrong direction, contradicts the agent's own earlier statement or breaks the fiction, while a truthful answer to a sincere question about being an AI never counts; adaptation-v1 passes a reply that acknowledges the user's state, changes approach, stays in character and avoids condescension, defensiveness and apology loops; false-positive-v1 marks a scene reply that treats the user's feeling as the companion's fault or breaks the scene; pairwise-reply-v1 returns `better_reply` (what the user needs now, what the reply should remember, the handling of frustration or confusion, accuracy) and `in_character` in one call, with the halo risk between them declared; pairwise-text-v1 returns `better_written` (clear, specific, natural, in voice, no padding; length is not a merit). Ties are allowed on both pairwise rubrics. Callbacks, persona facts and false premises are scored by normalized exact match first and graded against the gold fact when the match fails; a false premise answered as if remembered counts as confabulation. Style rules are checked by counters.

Each pair gets four votes, two judges in both orders, scored 1 for a win, 0.5 for a tie and 0 for a loss; the pair's score is their mean, and the endpoint is the mean pair score. A flag's score is the mean of the two judges' flags. Sensitivity analyses read a stricter pair rule (a win only when both judges give a win in both orders, a loss only when both give a loss) and each judge alone.

Calibration comes before any confirmatory item is judged. Each flag rubric has 20 strong controls (a reply spliced in from a contrasting card, a deleted acknowledgement, a wrong fact about the user), 20 mild controls (one trait inverted, one earlier self-statement contradicted) and 20 clean items that two independent readers confirm. The pairwise rubrics have 20 planted-worse pairs (truncated, repeated, an off-topic sentence inserted, a wrong fact) and 20 near-identical pairs, each judged in both orders. A judge passes a rubric when it detects at least 0.90 of the strong controls and 0.75 of the mild ones, flags at most 0.15 of the clean items, gives the same verdict in both orders on at least 0.80 of the control pairs, and agrees with the other judge at κ ≥ 0.60 on flags and κ ≥ 0.40 on pairwise controls. A failure allows one rubric revision and then one replacement judge from the same vendor; a second failure sets that axis to "no verdict". Calibration counts, for each judge, rubric and strength, the controls the judge answered against the controls the set holds, and any shortfall marks the axis incomplete, never passed. During the confirmatory runs, 10% extra planted controls are mixed in, and the run halts when the running detection rate falls below 0.90 after 10 or more controls.

Stability: a seeded 10% of the judgments and every control are judged twice, and a judge passes only with the same verdict on at least 0.90 of the flags and 0.80 of the pairwise items. Both readings are taken on every judging tranche, and a fall below either bar is treated as a judge that became unavailable. An unavailable judge pauses its task; after three days a calibrated replacement re-judges the whole task, or the task continues with one judge and its judged endpoints support only KILL or NOT SHOWN.

The A/A control judges B against a second sample of B, and C0 against a second sample of C0, on 30 pilot-pool prompts each, before any confirmatory judgment. An arm's row passes when its 95% interval contains 0.50; a row with fewer than 30 pairs is incomplete, and only a complete row passes or fails. A failure is traced and run again once on fresh prompts, and a second failure removes X1 from the decision.

A judgment is usable only with its full vote set: a pair with its four votes, a flag with both judges' answers, a repeated item with both repeats. A missing, discarded or unparseable reply is asked again until it is answered, or the item is set aside by name and listed in the report with its arm; the statistics read complete items only. Counting T1 at 500 items for B and for C and the other tasks at their planning sizes, the judges answer about 10,700 calls, about 800 of them for Z's judgments; 0b records the judging calendar the pilot's measured throughput gives.

### 4.6 Statistics

Every comparison is paired within the item, with a seeded arm order whose seed 0a fixes. Intervals come from a cluster bootstrap with 10,000 resamples and a fixed seed [26]. On T1 the clusters are LongMemEval-S histories and LOCOMO conversations; on T2 and T3 the bootstrap resamples at two levels, card and then conversation or script; on T4 the clusters are cards. The analysis treats the questions as clustered and the arm comparisons as paired (sections 2.2 and 4.2 of [27]). On recall the bootstrap governs, and McNemar's test is reported beside it.

Superiority uses a one-sided α of 0.015 at the full-sample look and 0.010 at the extension, with Holm's procedure [25] across one family of ten tests, R1, P1, Q1, S1 and X1 for C1 and for C0, where G1 takes R1's place when T1 is report-only (Section 4.4); a C0 and C1 pair served by reuse counts once. Non-inferiority uses the same α per endpoint, unadjusted, since GO requires every one. B − A and C − A are descriptions outside the family.

An interim look at half the sample stops an axis for efficacy or harm at |z| ≥ 3.29, and for futility when the upper 95% bound sits below the sizing margin and the point estimate is at most 0. An axis that stops early keeps its interim verdict, and the interim output reveals only "stop" or "continue".

Length control on T2, T3 and T4 pairs regresses each pair's score on the logarithm of the ratio of C's reply length to B's; the intercept is the length-adjusted effect [18], and validity gate V8 applies it to a win.

The planning sizes are those of Section 4.4. T1's size follows a rule read blind after 100 paired items: n = max(500, ⌈3,600 × d × deff⌉), where d is the observed discordance and deff the inflation from clustering, capped at all eligible items. The rule aims at a clustered standard error of at most 1.66 points, which gives 80% power for the −5-point margin at a one-sided α of 0.015. With 500 eligible LongMemEval-S items it takes all of them, so the aim holds only while 3,600 × d × deff stays at or below 500; above that, the report gives the precision and the minimum detectable effect that the 500 items reach. A blinded re-estimation after the first 100 T1 items and the first third of the T2, T3 and T4 items reads only nuisance parameters (discordance, intraclass correlation, the tie rate and the standard deviation), never the direction between arms, and may only raise sizes, toward 80% power and within the ceiling. When sizes must shrink to fit the ceiling, scripts are dropped in an order fixed in the protocol that keeps every HEXACO extreme covered; the reports give the number dropped per task, never a script's identity. 0b fixes the final sizes.

A simulation of the whole decision rule, looks included, runs at zero spend before 0b, over three scenarios: every endpoint equal, one endpoint better by its sizing margin, and one endpoint worse by its non-inferiority margin. Its targets are P(GO | one endpoint better) ≥ 0.80 and P(GO | all equal) ≤ 0.05; where the ceiling cannot meet both, 0b records the figures reached. 0b also states each endpoint's minimum detectable effect at 80% power.

An infrastructure failure that persists after three retries with backoff drops the item, or for a scripted task the whole script, from every arm, and is counted; failures an arm causes count against it as outcomes.

### 4.7 Validity gates

- **V0, build.** Live mode requires the integration suite, the determinism gate and the outbound-traffic check to pass.
- **V1, memory controls.** A given the gold evidence scores at least 10 points above A on the 100 T1 floor items, or R1 leaves the decision. B and C0 each beat A by at least 5 of the first 20 floor items; missing or empty memory is a harness defect, fixed and run again, never a memory verdict. A scores 10% or less on cross-session callbacks, or the run halts for leakage. The run halts when C's multi-session callback accuracy drops to A's level.
- **V2, prompt audit.** On every turn, memory is present and not empty in B and C and absent in A, the card's content hash is present, the personality section appears once, the persona id is the intended one, and every instruction of B's system text is in C's prompt; five items per arm are read by hand in the pilot.
- **V3 and V4, judge reliability.** Inter-judge κ and position consistency are gated on the planted controls; on the pairs of C against B they are reported and not gated, and a low κ there while V5 passes reads as "no detectable difference".
- **V5, planted controls.** The calibration bars of Section 4.5.
- **V6, failures.** Infrastructure failures are kept apart from failures an arm causes. Every arm runs under the same limits, so an expired turn budget is an outcome, judged as it stands and never retried.
- **V7, model identity.** Every response carries its pinned model id, checked separately for each purpose: arm, metaprompt, embedding, grader and judge. J1's model is recorded as requested, so V7 for J1 rests on its running checks.
- **V8, length.** When the winning side's replies average 20% or more longer, the win counts only if it survives the length-controlled analysis.
- **V9, configuration parity.** Identical caps in the captured requests, equal memory-configuration hashes, pinned metaprompt ids, and the frustration control passing on the running GMI.

A gate that fails is fixed in the harness and run again within the stage's spending cap (Section 5.4); a fix that needs AgentOS goes through its pull-request process, and the stage starts again on the published version; two failed fixes mean "not testable as configured".

### 4.8 The harness

The arms meet one seam: an arm opens a session for a conversation and runs a turn with the turn's addon and a deadline, under a clock pin, and every arm, the reference included, implements it. The seam and arms A, C0, C1 and Z live in the gmi-vs-agent family of the agentos-bench package, and the retrieval anchor R is added to the family with the revision after the pilot. The family imports only its own files, zod, Node built-ins and type-only AgentOS symbols, and receives the AgentOS module from its caller; it is not published (Section 9). B, B with the frozen sentence, the host-side sentiment port arm and the study runner live in a private runner, which takes a copy of the family pinned file by file to a bench commit.

Record mode and live mode share one code path. In record mode a local stub answers every model, embedding, rerank and guard call: the model list, canned replies by purpose, schema-valid metaprompt replies, 1,536-dimension character-hash embeddings and reranking by the same similarity, with delay and hang modes for the deadline. In live mode a metering proxy at the same addresses forwards each call with the study's own key, reserves its worst case before forwarding, applies the sampling rewrite, serves C1's reuse hits, counts tokens itself when a stream carries none, closes the upstream call at 60 seconds, and logs every call with its purpose, model, tokens (cached and reasoning tokens included), timings, request hash and status. A call whose answer ends without the vendor's terminal event is priced as a call closed at the timeout and relayed to the arm as a broken connection. The process clock is pinned while a turn runs, and latency is read from a monotonic timer. The determinism gate runs a record script twice and requires the same received requests once the volatile fields the harness lists are masked.

An arm's cost per turn counts every call its turn causes, priced at the day's prices with cached and reasoning tokens. The proxy records a call's arm when the call reaches it, so a call in flight when its turn is cut at the deadline stays charged to that turn's arm; the one exception is a call that a cut turn's unfinished work sends after the deadline and that reaches the proxy during a later turn, which is charged to the arm whose turn runs then. Judging runs on model clients billed at a flat rate, outside the ledger, and is not in the spend figures. A durable ledger, a file committed to a private branch, holds one entry per run; it reserves each run's worst case before the job that holds the keys starts, refuses a run that would pass the stage's cap, and settles a run only after the proxy holds no call in flight.

Live runs are isolated. The workflow runs one study job at a time, in an environment that holds the study's keys; a socket guard in the arms' process admits a vendor host only on the proxy's own connections and halts the run on any other; an operating-system rule on the runner refuses every connection the study's processes open other than loopback, name lookups and HTTPS, logs refused connections and HTTPS connections to addresses no vendor host resolved to, and fails the leg when the log holds either; and a live run starts only after a record run of its legs logged no stray connection.

One generator writes the study report. It reads a run's results and call log and, when given them, the ledger, the price table, the judgment sets, the determinism record, the materials' provenance, the T1 pack and the run header, and writes a markdown file, a self-contained HTML file whose content security policy loads nothing, and a PDF printed from the HTML by headless Chrome, in thirteen fixed sections, to which the confirmatory analysis's report adds one, "Verdicts" (Appendix A). It calls no model: every number comes from a file, and an input not given reads "not run". A public mode renders the same inputs with item and card ids replaced by ordinals and input files by their kind and base name, and a scan in CI fails a public copy on any private name or internal reference; only public copies are published.

### 4.9 Registration and deviations

The protocol is frozen in two private files. 0a holds the design, the materials' hashes, the seeds, the thresholds, the analysis plan and the conditional rules, and is frozen before any paid call. 0b holds the judges' pins, the rubric versions after any revision, the measured unit costs, the blinded nuisance estimates, the simulation's results, the final sizes, the resolved conditionals and the AgentOS version, and is frozen after the pilot and calibration and before the first confirmatory item.

A frozen file never changes. The pilot's additions and any later deviation go into a dated addendum beside it, in three parts: amendments (a change to a rule or a design value, dated, with its reason, committed before the first live call it affects), records (what the pilot pins, reads or measures under the frozen rules), and deviations found after the freeze, written in public words. The SHA-256 of each frozen file appears on the study page before the data it governs, followed by one dated line per amendment, and the merge commit's date on the public repository dates each hash. The files stay private, so the hash is a dated commitment that an auditor given the files can check, not a check any reader can make; the page's dated method is the public record of the design [28]. Every report prints the frozen file's hash, its addendum's hash and the deviations of both.

Pilot data never enter the analysis. A harness defect found after the pilot voids the affected items in every arm, and they are run again after the fix, with the difference recorded. The revision of the design after the pilot rests only on figures that compare no arms on judged quality: unit costs, latency, the judge clients' throughput, tie and unparseable rates, firing rates and the judges' agreement on the planted controls.

## 5. Experimental setup

### 5.1 The subject model

The subject is the model of the reference product's quality tier that served the most companion replies over the window its reply records cover before 0a is frozen, read once and read-only. Those records start on 2026-10-05, so the window is shorter than the 30 days the design planned. 0a records the window, the counts and the model, and every report names the model; this section names it once 0a is frozen.

### 5.2 Vendors, keys and spend controls

The study calls its vendors with keys of its own, on prepaid balances, with vendor-side limits wherever a vendor offers them. Only the dispatch-only workflow on the default branch can read the keys, never a fork or a pull request, and the keys are revoked after the study. No product key is used. Until vendor usage reconciles it, computed spend counts against the cap at 1.5 times its value.

### 5.3 Materials and data

The main set has twelve persona cards. Eleven have at least two HEXACO traits above 0.7 or below 0.3, every trait appears at least once above 0.7 and at least once below 0.3 across the set, and one card is a control with every trait strictly between 0.45 and 0.55. Each card carries ten checkable persona facts and three style rules a counter can check. A card's six HEXACO values are stored with its companion in the reference product, which renders each trait as a behaviour phrase in its character text: a strong phrase above 0.7 or below 0.3, a softer one from 0.55 to 0.7 or from 0.3 to 0.45, and none strictly between 0.45 and 0.55, so the control card renders no trait phrase. The cards' bands are those of the phrases, and the phrases are part of B's static system text, which C, A and Z carry (Section 4.2). Two more cards serve calibration only, and a neutral card with every trait at 0.5 serves T1. A model client with no repository access writes the cards, the scripts and the fixed contexts from a brief; the writers of the sentiment scripts never see the sentiment lexicon, and no script is edited after any firing result. No conversation from the reference product's users goes to any vendor. T1 sends the vendors the histories of its two datasets, and LongMemEval-S draws its histories' sessions from simulated chats and from ShareGPT and UltraChat, publicly released chat data [2]. 0a hashes the materials, and they stay private.

### 5.4 Budget and sample size

The live pilot runs ten legs under a $10 cap; when the projection passes the cap, legs are dropped in a fixed order, and the first five are never dropped. The confirmatory ceiling is set inside $500 to $1,000 from the pilot's measured unit costs, before the first confirmatory tranche. The ceiling bounds the sample size, so every endpoint's result comes with its minimum detectable effect, its planned and achieved n, and the number of scripts dropped per task to fit the ceiling, with every HEXACO extreme kept covered and never a script's identity; an endpoint the ceiling leaves unproven is named as such.

### 5.5 The pilot

> Pending the live pilot's report set. This subsection is filled from `reports/pilot-<date>-<CI run id>/README.md` and the sections "Cost per arm, tokens, cached tokens and the counterfactual", "Latency per arm" and "The spend ledger" of each leg's `report.md`. Pilot figures describe the setup and do not enter any result.

### 5.6 The judging calendar

The planning volume is about 10,700 judge calls, counting T1 at 500 items for B and for C, about 800 of them for Z's judgments (Section 4.5). The pilot measures the judge clients' throughput; the calendar is set from it phase by phase (preparation, calibration with the A/A control, then the confirmatory sets), and 0b records the calendar and the judging deadline.

## 6. Results

The results are pending the confirmatory analysis. Each table below names the report file and the report section that fill it; pilot data enter none of them. Z is the floor control and never a contestant, C against Z is read only on absolute scores, and no table or sentence adds C − A to A − Z.

### 6.1 Validity gates and calibration

Table 1. Validity gates V0 to V9, the calibration axes per judge and rubric, the stability check and the A/A control.

| Gate or check | B | C0 | C1 | Reading |
|---|---|---|---|---|

> Pending the confirmatory analysis. This table is filled from `reports/<confirmatory set>/report.md`, sections "Verdicts" (the validity gates' readings), "Metrics, judges and pins" (the calibration axes and the A/A control) and "The determinism gate and the stability check", at the analysis run that set's README names. Pilot data do not enter it.

### 6.2 Primary endpoints

Table 2a. R1, P1 and S1 per arm, with 95% intervals. Q1 and X1 are pair scores of C against B, so they have no value per arm; Table 2b gives them.

| Endpoint | B (interval) | C0 (interval) | C1 (interval) |
|---|---|---|---|

> Pending the confirmatory analysis. This table is filled from `reports/<confirmatory set>/report.md`, section "Results per family", at the analysis run that set's README names. Pilot data do not enter it.

Table 2b. C1 − B and C0 − B on each primary endpoint, each measure oriented as in Section 4.4 (P1 as B − C, and Q1 and X1 as the pair score of C against B): the estimate, its interval, the Holm-adjusted outcome, the planned and achieved n and the minimum detectable effect.

| Endpoint | C1 − B (interval) | Outcome | C0 − B (interval) | Outcome | Planned n | Achieved n | Minimum detectable effect |
|---|---|---|---|---|---|---|---|

> Pending the confirmatory analysis. This table is filled from `reports/<confirmatory set>/report.md`, section "Verdicts", at the analysis run that set's README names. Pilot data do not enter it.

### 6.3 Guards

Table 3a. G1 and G2 per arm, with 95% intervals.

| Guard | B (interval) | C0 (interval) | C1 (interval) |
|---|---|---|---|

> Pending the confirmatory analysis. This table is filled from `reports/<confirmatory set>/report.md`, section "Results per family", at the analysis run that set's README names. Pilot data do not enter it.

Table 3b. C1 − B and C0 − B on G1 and G2, each measure oriented as in Section 4.4 (G2 as B − C), with the reading against "not WORSE".

| Guard | C1 − B (interval) | Outcome | C0 − B (interval) | Outcome |
|---|---|---|---|---|

> Pending the confirmatory analysis. This table is filled from `reports/<confirmatory set>/report.md`, section "Verdicts", at the analysis run that set's README names. Pilot data do not enter it.

### 6.4 Descriptive contrasts

Table 4. B − A and C − A on every axis, A − Z, Z's absolute scores, and C against Z on the absolute scores of the items both ran. A contrast that no judged pair covers on an axis judged only in pairs reads "not measured". These contrasts are descriptions: none enters a decision rule.

| Contrast | Axis | Estimate (interval) | Items |
|---|---|---|---|

> Pending the confirmatory analysis. This table is filled from `reports/<confirmatory set>/report.md`, sections "Verdicts" (B − A and C − A), "Pairwise verdicts" (A against Z) and "Results per family" (Z's absolute scores and C against Z), at the analysis run that set's README names. Pilot data do not enter it.

### 6.5 Cost and latency

Table 5a. Mean dollars per turn per arm, tokens, cached tokens, and the caching counterfactual for C.

| Arm | Dollars per turn | Input tokens | Cached tokens | Output tokens | Counterfactual |
|---|---|---|---|---|---|

> Pending the confirmatory analysis. This table is filled from `reports/<confirmatory set>/report.md`, section "Cost per arm, tokens, cached tokens and the counterfactual", at the analysis run that set's README names. Pilot data do not enter it.

Table 5b. First-token latency at the median and the 95th percentile, and last-token latency at the 95th percentile, per arm.

| Arm | First token, median | First token, 95th percentile | Last token, 95th percentile |
|---|---|---|---|

> Pending the confirmatory analysis. This table is filled from `reports/<confirmatory set>/report.md`, section "Latency per arm", at the analysis run that set's README names. Pilot data do not enter it.

### 6.6 Spend

Table 6. The spend per stage against its cap.

| Stage | Cap | Counted spend | Runs |
|---|---|---|---|

> Pending the confirmatory analysis. This table is filled from `reports/<confirmatory set>/report.md`, section "The spend ledger", at the analysis run that set's README names. Pilot data do not enter it.

### 6.7 Deviations

> Pending the confirmatory analysis. This list is filled from `reports/<confirmatory set>/report.md`, section "Limitations", which prints the deviations of 0a, of 0b and of their addenda, at the analysis run that set's README names.

## 7. Discussion

Pending the verdict. This section is written after the verdict, under the separate decision that governs public claims from this study.

It then follows these rules. A tie reads "no advantage detected; the study had 80% power to detect one as large as the minimum detectable effect; smaller ones are not ruled out", and the exclusion "no advantage as large as the minimum detectable effect" is written only where the interval's upper bound sits below that effect. A KILL reads "no gain large enough to pay for migration in the tested configuration", and "GMIs are not better" is written only where the intervals rule out a gain. A NO VERDICT names the validity gate that could not pass within the ceiling; an axis without a verdict names the calibration its judges failed; a task left with one judge says that its judged endpoints could support only KILL or NOT SHOWN. Every claim names only the configuration measured.

## 8. Threats to validity

**Internal.** B's per-turn system text is not frozen: each turn's text comes from B's own request, without its memory section, and C receives the same text, so the arms share the state B's own run gives it. C1 runs right after C0, so C1's cache reads are a covariate, and a C1 main request equal to C0's after masking reuses C0's reply. The arms' prompt-cache layouts differ. One wall deadline cuts every arm's turn alike. The recorded asymmetries each favour one side: B reloads its last 50 stored messages where C, A and Z keep 60, which favours C and A on the later turns of T2's 30-turn sessions; a GMI turn stops its tool loop at 5 steps where B allows 12, which favours B on a turn that needs more steps, and the pilot counts B's turns past 5 steps. The revision of the design after the pilot is made with the pilot's per-arm reports in view; by rule it rests on no figure that compares arms on judged quality (Section 4.9).

**Construct.** The judges are model proxies, read through planted controls and repeats [6, 24]. LOCOMO's golden answers carry known errors, and the same audit reports a model judge that accepted 62.81% of intentionally wrong, vague but topical answers [8], which bears on T1's model grading. The materials are synthetic and written by a model, and the companion setting is one product's.

**Judging.** J1's client reports no served model, so J1's model is recorded as requested and unverified. A judge from the subject's vendor may favour the subject's style [17]. Every arm's replies come from the subject model, so such a preference reaches every arm, but not necessarily equally, since the arms differ in system text, memory placement, tools and length; the second judge from another vendor, length control and the per-judge agreement the reports print are what bound it. Position and length effects [15, 16, 18] are met by both orders, swapped labels and length control.

**Statistical.** The intervals assume that clusters are independent [26, 27]. LOCOMO's ten conversations are too few clusters for pooling, so LOCOMO is reported apart from R1. The primary endpoints are tested as one family under Holm's procedure [25].

**External.** One subject model, one configuration (C1 with the five presets on and no trait adjustment, no retrieval augmentor or RAG, the reference product's memory configuration and window) and one pinned AgentOS version.

**Z's construction.** With an Anthropic subject, Z reaches the model through a compatibility layer that its vendor describes as primarily intended to test and compare model capabilities and not as a long-term or production-ready solution for most use cases, that supports no prompt caching, and that joins system messages with a single newline [30]. The probe on the day of a live run checks each sampling field, and Z falls back to the vendor's Messages API when a field is ignored. Z enters no decision rule.

## 9. Reproducibility

Public: the method (the [study page](../../evaluation/GMI_VS_AGENT.md) and this paper) and the arms' library code in AgentOS; then, as each is produced, the SHA-256 of 0a and of 0b on the study page, each before the data it governs, and the report sets, listed under the study page's "Reports and results", with each report's run identity in public form (the harness named as the unpublished agentos-bench gmi-vs-agent family with its revision, and the CI run id) and each file's SHA-256 in the set's README. Private: the gmi-vs-agent family's code, which is not in the public agentos-bench repository (the revision the reports print is that private code's), the runner that drives B, the materials, the raw outputs, the judgments and the ledger, kept in a private repository with durable storage. Record mode runs in the project's CI on every change to the harness, and a record-mode report set shows the harness's mechanics, not the arms. The family's code is not published with this paper, so record mode runs only in the project's CI; a release of the family is a separate decision.

## Competing interests

The AgentOS project builds both the runtime under test and the reference product, the companion chat of wilds.ai, and the study informs the project's own product decision. The project designed the study, wrote its materials and runs its analysis.

## References

[1] Adyasha Maharana, Dong-Ho Lee, Sergey Tulyakov, Mohit Bansal, Francesco Barbieri, Yuwei Fang. Evaluating Very Long-Term Conversational Memory of LLM Agents. Proceedings of the 62nd Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers), pp. 13851-13870, 2024. https://doi.org/10.18653/v1/2024.acl-long.747 and https://arxiv.org/abs/2402.17753 (read 2026-10-11; arXiv version v1).

[2] Di Wu, Hongwei Wang, Wenhao Yu, Yuwei Zhang, Kai-Wei Chang, Dong Yu. LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory. ICLR 2025 (per the arXiv record). https://arxiv.org/abs/2410.10813 (read 2026-10-11; arXiv version v2).

[3] Charles Packer, Sarah Wooders, Kevin Lin, Vivian Fang, Shishir G. Patil, Ion Stoica, Joseph E. Gonzalez. MemGPT: Towards LLMs as Operating Systems. arXiv preprint, 2023. https://arxiv.org/abs/2310.08560 (read 2026-10-11; arXiv version v2).

[4] Joon Sung Park, Joseph C. O'Brien, Carrie J. Cai, Meredith Ringel Morris, Percy Liang, Michael S. Bernstein. Generative Agents: Interactive Simulacra of Human Behavior. Proceedings of the 36th Annual ACM Symposium on User Interface Software and Technology (UIST '23), pp. 1-22, 2023. https://doi.org/10.1145/3586183.3606763 and https://arxiv.org/abs/2304.03442 (read 2026-10-11; arXiv version v2).

[5] Theodore R. Sumers, Shunyu Yao, Karthik Narasimhan, Thomas L. Griffiths. Cognitive Architectures for Language Agents. Transactions on Machine Learning Research (per the arXiv record); arXiv preprint, 2023. https://arxiv.org/abs/2309.02427 (read 2026-10-11; arXiv version v3).

[6] Lianmin Zheng, Wei-Lin Chiang, Ying Sheng, Siyuan Zhuang, Zhanghao Wu, Yonghao Zhuang, Zi Lin, Zhuohan Li, Dacheng Li, Eric P. Xing, Hao Zhang, Joseph E. Gonzalez, Ion Stoica. Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena. NeurIPS 2023 Datasets and Benchmarks Track (per the arXiv record). https://arxiv.org/abs/2306.05685 (read 2026-10-11; arXiv version v4).

[7] Michael C. Ashton, Kibeom Lee. Empirical, Theoretical, and Practical Advantages of the HEXACO Model of Personality Structure. Personality and Social Psychology Review 11(2), 150-166, 2007. https://doi.org/10.1177/1088868306294907 (read 2026-10-11).

[8] dial481 (repository owner). locomo-audit: LoCoMo Benchmark Audit, repository README. GitHub, not peer reviewed, undated page. https://github.com/dial481/locomo-audit (read 2026-10-11).

[9] Prateek Chhikara, Dev Khant, Saket Aryan, Taranjeet Singh, Deshraj Yadav. Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory. arXiv preprint, 2025. https://arxiv.org/abs/2504.19413 (read 2026-10-11; arXiv version v1).

[10] Preston Rasmussen, Pavlo Paliychuk, Travis Beauvais, Jack Ryan, Daniel Chalef. Zep: A Temporal Knowledge Graph Architecture for Agent Memory. arXiv preprint, 2025. https://arxiv.org/abs/2501.13956 (read 2026-10-11; arXiv version v1).

[11] Wanjun Zhong, Lianghong Guo, Qiqi Gao, He Ye, Yanlin Wang. MemoryBank: Enhancing Large Language Models with Long-Term Memory. arXiv preprint, 2023. https://arxiv.org/abs/2305.10250 (read 2026-10-11; arXiv version v3).

[12] Vinay Samuel, Henry Peng Zou, Yue Zhou, Shreyas Chaudhari, Ashwin Kalyan, Tanmay Rajpurohit, Ameet Deshpande, Karthik Narasimhan, Vishvak Murahari. PersonaGym: Evaluating Persona Agents and LLMs. Findings of EMNLP 2025 (per the arXiv record). https://arxiv.org/abs/2407.18416 (read 2026-10-11; arXiv version v5).

[13] Quan Tu, Shilong Fan, Zihang Tian, Rui Yan. CharacterEval: A Chinese Benchmark for Role-Playing Conversational Agent Evaluation. arXiv preprint, 2024. https://arxiv.org/abs/2401.01275 (read 2026-10-11; arXiv version v2).

[14] Hannah Rashkin, Eric Michael Smith, Margaret Li, Y-Lan Boureau. Towards Empathetic Open-domain Conversation Models: a New Benchmark and Dataset. ACL 2019, long paper (per the arXiv record). https://arxiv.org/abs/1811.00207 (read 2026-10-11; arXiv version v5).

[15] Peiyi Wang, Lei Li, Liang Chen, Zefan Cai, Dawei Zhu, Binghuai Lin, Yunbo Cao, Qi Liu, Tianyu Liu, Zhifang Sui. Large Language Models are not Fair Evaluators. arXiv preprint, 2023. https://arxiv.org/abs/2305.17926 (read 2026-10-11; arXiv version v2).

[16] Lin Shi, Chiyu Ma, Wenhua Liang, Xingjian Diao, Weicheng Ma, Soroush Vosoughi. Judging the Judges: A Systematic Study of Position Bias in LLM-as-a-Judge. AACL-IJCNLP 2025 (per the arXiv record). https://arxiv.org/abs/2406.07791 (read 2026-10-11; arXiv version v9).

[17] Arjun Panickssery, Samuel R. Bowman, Shi Feng. LLM Evaluators Recognize and Favor Their Own Generations. arXiv preprint, 2024. https://arxiv.org/abs/2404.13076 (read 2026-10-11; arXiv version v1).

[18] Yann Dubois, Balázs Galambosi, Percy Liang, Tatsunori B. Hashimoto. Length-Controlled AlpacaEval: A Simple Way to Debias Automatic Evaluators. COLM 2024 (per the arXiv record). https://arxiv.org/abs/2404.04475 (read 2026-10-11; arXiv version v2).

[19] Guiming Hardy Chen, Shunian Chen, Ziche Liu, Feng Jiang, Benyou Wang. Humans or LLMs as the Judge? A Study on Judgement Biases. EMNLP 2024 (per the arXiv record). https://arxiv.org/abs/2402.10669 (read 2026-10-11; arXiv version v5).

[20] Ryan Koo, Minhwa Lee, Vipul Raheja, Jong Inn Park, Zae Myung Kim, Dongyeop Kang. Benchmarking Cognitive Biases in Large Language Models as Evaluators. ACL 2024 (per the arXiv record). https://arxiv.org/abs/2309.17012 (read 2026-10-11; arXiv version v3).

[21] Rickard Stureborg, Dimitris Alikaniotis, Yoshi Suhara. Large Language Models are Inconsistent and Biased Evaluators. arXiv preprint, 2024. https://arxiv.org/abs/2405.01724 (read 2026-10-11; arXiv version v1).

[22] Aman Singh Thakur, Kartik Choudhary, Venkat Srinik Ramayapally, Sankaran Vaidyanathan, Dieuwke Hupkes. Judging the Judges: Evaluating Alignment and Vulnerabilities in LLMs-as-Judges. Proceedings of the Fourth Workshop on Generation, Evaluation and Metrics (GEM²), pp. 404-430, 2025 (the arXiv journal reference). https://arxiv.org/abs/2406.12624 (read 2026-10-11; arXiv version v6).

[23] Sijun Tan, Siyuan Zhuang, Kyle Montgomery, William Y. Tang, Alejandro Cuadron, Chenguang Wang, Raluca Ada Popa, Ion Stoica. JudgeBench: A Benchmark for Evaluating LLM-based Judges. ICLR 2025 (per the arXiv record). https://arxiv.org/abs/2410.12784 (read 2026-10-11; arXiv version v2).

[24] Sumanth Doddapaneni, Mohammed Safi Ur Rahman Khan, Sshubam Verma, Mitesh M. Khapra. Finding Blind Spots in Evaluator LLMs with Interpretable Checklists. EMNLP 2024 (per the arXiv record). https://arxiv.org/abs/2406.13439 (read 2026-10-11; arXiv version v2).

[25] Sture Holm. A simple sequentially rejective multiple test procedure. Scandinavian Journal of Statistics 6(2), 65-70, 1979 (zbMATH 0402.62058; the issue number from Wikipedia's citation of the article). https://www.jstor.org/stable/4615733 and https://zbmath.org/?q=an:0402.62058 (read 2026-10-11).

[26] C. A. Field, A. H. Welsh. Bootstrapping Clustered Data. Journal of the Royal Statistical Society Series B: Statistical Methodology 69(3), 369-390, 2007. https://doi.org/10.1111/j.1467-9868.2007.00593.x (read 2026-10-11).

[27] Evan Miller. Adding Error Bars to Evals: A Statistical Approach to Language Model Evaluations. arXiv preprint, 2024. https://arxiv.org/abs/2411.00640 (read 2026-10-11; arXiv version v1; sections 2.2 and 4.2 read in the HTML version, https://arxiv.org/html/2411.00640v1).

[28] Brian A. Nosek, Charles R. Ebersole, Alexander C. DeHaven, David T. Mellor. The preregistration revolution. Proceedings of the National Academy of Sciences 115(11), 2600-2606, 2018. https://doi.org/10.1073/pnas.1708274114 (read 2026-10-11).

[29] Ron Kohavi, Diane Tang, Ya Xu. Trustworthy Online Controlled Experiments: A Practical Guide to A/B Testing. Cambridge University Press, 2020; chapter 19, "The A/A Test", pp. 200-208. https://doi.org/10.1017/9781108653985 and https://doi.org/10.1017/9781108653985.025 (read 2026-10-11).

[30] Anthropic. OpenAI SDK compatibility. Claude Platform Docs, vendor documentation, undated page. https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk (read 2026-10-11).

## Appendix A: the study report

Every run's report has thirteen sections, in this order. The files a section reads are named in public words; every report lists each file it read, with its SHA-256, in its appendix.

| Section | Title | What it reads |
|---|---|---|
| 1 | Run identity | the results file, the call log (the vendors called) and the run header |
| 2 | The question | nothing: fixed text |
| 3 | The arms | the results file |
| 4 | Task families and item counts | the results file |
| 5 | Metrics, judges and pins | the judgment sets: their manifests, the judges' pins and the replies |
| 6 | Results per family | the results file, the judgment sets and the T1 pack (T1's clusters) |
| 7 | Pairwise verdicts | the judgment sets, the results file and the T1 pack |
| 8 | Cost per arm, tokens, cached tokens and the counterfactual | the call log and the day's price table |
| 9 | Latency per arm | the results file and, in a live run, the call log (the sentiment call's share of C1's latency) |
| 10 | The determinism gate and the stability check | the determinism record, the results file and the judgment sets |
| 11 | The spend ledger | the ledger |
| 12 | Limitations | fixed text, the run header (the protocol's deviations) and the call log (Z's wire) |
| 13 | Appendix: rubric hashes, materials provenance and the price table | every file the report read, the judgment sets' rubric hashes, the materials' provenance, the T1 pack and the day's price table |

The confirmatory analysis's report comes from the same generator over the pooled confirmatory results and adds one section, "Verdicts", after "The spend ledger". It gives, for each endpoint, C1 − B and C0 − B with their intervals and their outcomes under the tests of Section 4.4, Holm-adjusted where Section 4.6 applies the correction, and the endpoint's planned and achieved n and its minimum detectable effect; B − A and C − A on every axis, as descriptions with no outcome, where a contrast that no judged pair covers on an axis judged only in pairs reads "not measured"; the validity gates' readings; the readings against the cost, latency and failure ceilings; and the outcome under the decision rules: GO, GO-COST, PORT, KILL, NOT SHOWN or NO VERDICT. A run's report has no such section and applies no decision rule.

## Appendix B: rubrics

The rubric texts are fixed in the protocol and stay private; every report prints their hashes in its appendix.

| Rubric | What it judges |
|---|---|
| `persona-violation-v1` | One reply: whether it contradicts a card fact, shows a trait in the wrong direction, contradicts the agent's own earlier statement or breaks the fiction; a 1 to 5 adherence score as a secondary |
| `adaptation-v1` | One reply after a cue: whether it acknowledges the user's state, changes approach, stays in character and avoids condescension, defensiveness and apology loops |
| `false-positive-v1` | One scene reply: whether it treats the user's feeling as the companion's fault or breaks the scene |
| `t1-grade` | One T1 answer against the dataset's gold answer, with LongMemEval's grading prompt for the question's type (Section 4.3) |
| `probe-grade` | One T2 probe answer (a callback, a persona fact or a false premise) against its gold fact, after a normalized exact match fails |
| `pairwise-reply-v1` | Two replies: `better_reply` and `in_character`, in one call, ties allowed |
| `pairwise-text-v1` | Two single-turn replies: `better_written`, ties allowed |

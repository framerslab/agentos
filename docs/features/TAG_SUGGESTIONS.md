# Tag Suggestions

A design for proposing tags for a text a host holds: a document, a kept transcript or a note. The module proposes; the host decides what to show and records what a person adds or dismisses. Every proposal rests on words quoted from the text, so a person can see why it was made, and the module keeps nothing between calls.

The module will live in `src/cognition/library/`, beside the tag grammar (`tags.ts`) and the word rule (`tokens.ts`), and ship in `@framers/agentos` with no new dependency. This page is its design note. The section [What is built](#what-is-built) says which parts exist; each change that adds a part grows that section and the scores below.

## What is built

- The fixture texts under [`tests/fixtures/tags/`](../../tests/fixtures/tags/README.md), written for this repository and holding no person's content.
- The scoring harness, [`src/cognition/library/__tests__/tags.scoring.test.ts`](../../src/cognition/library/__tests__/tags.scoring.test.ts), and the CI job "Tag suggestions (fixtures and scores)" that runs it on every pull request and on the release's run. Every part of the report reads `missing`, since none of the parts it scores exists.
- The tag grammar, [`src/cognition/library/tags.ts`](../../src/cognition/library/tags.ts), exported from both entries, `@framers/agentos/cognition/library` and `@framers/agentos/cognition/library/browser`. It is described under [The grammar](#the-grammar).

The steps and checks below are the design each later change builds.

## The grammar

A tag is 1 to 40 code points in NFC and lower case: runs of letters and decimal digits, with single hyphens between runs in what a person types. `normalizeTag` makes typing a tag (`Q3 Planning!` gives `q3-planning`), and refuses rather than cuts. `tagKey` and `canonicalTag` drop the hyphens, so `q3-planning` and `q3planning` are one tag, whose key is `q3planning`. `classifyLegacyTag` reads a label stored before the grammar: an alias of its key when case, Unicode normalization and separators alone stand between them, unresolved otherwise (`C++`, `C#`, an emoji), and an unresolved label is never counted under its candidate key.

- **The vocabulary.** `tagVocabulary(documents)` reads `TagDocument`s of three kinds, `note`, `session` and `document`, and gives one `TagUse` a key: `uses`, the documents that hold it, each counted once, with `notes`, `sessions` and `documents` by kind, and `lastUsed`, the latest `changedAt` among them. Its `label` is the person's own spelling of the key: of the labels the documents hold for it, the one on the most documents, then the one on the latest changed document, then the first by code point. `Q3 Planning` on three documents and `q3-planning` on one give the label `Q3 Planning` for the key `q3planning`. The documents are read and never changed, and no stored label is rewritten.
- **A candidate's resolution.** `resolveTag(candidate, vocabulary)` makes a candidate an existing tag by its key, by its stem (one spaced word) or one edit away (both keys 5 code points or more, the same digits, a script written with spaces), and answers that tag's key as `tag` and the vocabulary's `label` for it. A new tag's `tag` is its key and its `label` is `normalizeTag`'s form: `Road Map 2027!` gives the key `roadmap2027` and the label `road-map-2027`.
- **Rename and merge.** `renameTag(tags, from, to)` writes every label of `from`'s key as `to`. `mergeTags(tags, from, into)` takes every label of `from`'s key away and puts `into` at the first place either stood, in the spelling the list holds for it, else as given. Both work by key, keep the list's order, keep each tag once, leave a label with no key (`C++`) where it stands, and return a new list. A list that holds no label of `from` comes back unchanged.

`TagUse` holds `label` and `documents`, and each `TagResolution` holds `label`. A vocabulary row an application builds for itself needs both members; one read from `tagVocabulary` has them.

## The steps

A suggestion passes four steps, in this order.

1. **Candidates from the text's own words.** `extractTagCandidates` takes an item's title, its headings, a file's name or path and its text, and finds each key of the host's vocabulary among the text's words: by its key, by its stem (one spaced word), or one edit away (a key of five code points or more in a spaced script, with the same digits), as `resolveTag` resolves a candidate. It reads the text's NFC form, and every span a candidate carries names that same text. It reads at most `maxChars` characters. Statistical keyword scoring and phrase and graph ranking are later techniques, each written from its paper.
2. **The vocabulary, the ranking and the caps.** Each candidate resolves through `resolveTag` against the vocabulary the host passes. Existing tags rank first, by the person's own use counts, then new ones. At most five proposals are offered at a time, at most three of them new. Past a vocabulary of 500 tags, only existing tags are offered. A key the item holds, or one the host says was declined on that item, is never proposed.
3. **A model proposer a host may pass.** `modelTagProposer`, from the library entry alone, builds a bounded input, takes the model call from the host, and puts every answer through the same checks. Its input is bounded in UTF-8 bytes, not estimated from characters, because symbols, scripts of three and four bytes a character and long identifiers all pass a character estimate.
4. **The host's record.** The host passes the keys an item holds and the keys a person declined on it; the module reads them and stores nothing.

## The checks every proposal passes

Each check runs in code, after every step, never left to an instruction to a model.

- **Quotes found word for word.** Every proposal carries one or two quotes of the item's text, 25 words at most each, found in the text after folding as `foldText` folds. A proposal whose quotes are not found is dropped.
- **The label check.** A new tag's words stand in its quotes, with its names, numbers and negations among the quotes' own, so a label never turns "not approved" into "approved".
- **The refusal list and the name check.** A health matter, a belief, a party, a union, an origin, an immigration status, a criminal matter, genetic data, or a person's name is never proposed as a new tag. A label the person typed themselves may be offered back to that person alone, from the vocabulary.
- **The language check.** A new tag is proposed only for a text the language detector (`detectLanguageTrigram`) calls English; any other text gets existing tags only.
- **Instructions in the text.** A text can ask a model for a tag. No tag a text asks for is taken from the answer on that ground.

## The browser entry

`@framers/agentos/cognition/library/browser` will export the same functions except the model proposer. It reaches no network module and no Node module, and the test that walks its import graph covers every new file.

## The fixture set

[`tests/fixtures/tags/`](../../tests/fixtures/tags/README.md) holds one JSON file a text, in six sets, with the label check's cases beside them. Its README gives the shape of a file and how a case is added.

| Set | Files | What it tests |
|---|---|---|
| `plain` | 20 | English work documents: the vocabulary match, the ranking, a vocabulary past 500 tags, texts with nothing a tag can rest on |
| `sessions` | 10 | Transcripts with their report's tags, two of which rest on quotes the text does not hold |
| `sensitive` | 10 | Words and invented names no step may propose as a new tag, and labels the person typed |
| `languages` | 10 | One text each in Spanish, French, German, Portuguese, Japanese, Chinese, Korean, Arabic, Hindi and Russian |
| `injection` | 5 | A passage asking a model for a tag: in a heading, mid-paragraph, in a quoted block, as a comment line, across two lines |
| `bytes` | 4 | Texts a character estimate of tokens undercounts, each with 150 labels of 40 code points |

`src/cognition/library/__tests__/tags.fixtures.ts` loads them (`loadTagFixtures`, `loadLabelCases`) and makes a long text on demand (`longFixture`). `tags.fixtures.test.ts` checks the set itself: each file parses and has its own id, each set holds its count, every word a fixture says must not be proposed stands in its text, every asked tag stands in its text and in no expected list, no fixture holds an email address, a telephone number or a long run of digits, every expected tag is a key of the right vocabulary, and each bytes fixture is longer in bytes than a character estimate counts.

## The scoring job

The job "Tag suggestions (fixtures and scores)" in `.github/workflows/ci.yml` runs on every pull request and on the release's run. It references no secret. It runs the fixtures' checks and the scoring harness, which loads both entries and scores each part an entry exports:

| Report member | What it holds | Kind |
|---|---|---|
| `engine` | The engine's revision the scores were taken on | figure |
| `step1` | Step 1's recall of the shortlist apart from the final choices, its recall of existing and new tags, its precision | figures, no threshold |
| `step3` | The model proposer's recall and precision; it needs a provider key, and reads `missing` in this job | figures, no threshold |
| `quotes` | Proposals shown and those whose quotes were found | hard check: one miss fails the job |
| `refusals` | Words and names that should not be proposed and were | hard check: one leak fails the job |
| `language` | Texts the language check answered right | figure |
| `injection` | Answers holding a tag the text asked for | hard check: one leak fails the job |
| `browserGraph` | The browser entry's import graph reaching no network module | hard check |
| `bytes` | The model input's largest size in bytes on the bytes fixtures | hard check: over 4,000 fails the job |
| `timing` | The extractor's time on a text of a million characters | figure |

A part no entry exports reads `missing`, never a number and never a pass. A part an entry exports with no scorer in the harness fails the job, so a part lands with its scorer. The job writes the report as a table to the run's summary and keeps `report.json` as the artifact `tags-report-<commit>` for 30 days.

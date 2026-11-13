# Fixture texts for the tag suggestion tests

These are the texts the tag suggestion tests of `src/cognition/library/` score. Every text here was written for this
folder. None is a person's content, and none is copied from a document. The names of people in them are invented.

The loader is `src/cognition/library/__tests__/tags.fixtures.ts`. The fixtures' own checks are in
`tags.fixtures.test.ts` beside it, and the scoring harness is `tags.scoring.test.ts`. CI's job "Tag suggestions
(fixtures and scores)" runs both and writes the scores to the run's summary. The guide is
[`docs/features/TAG_SUGGESTIONS.md`](../../../docs/features/TAG_SUGGESTIONS.md).

## The sets

| Folder | Files | What each holds |
|---|---|---|
| `plain/` | 20 | An English work document (`kind` `document`): a budget review, a roadmap, meeting minutes and the like. Four hold a `path`. Six hold a vocabulary of 20 to 60 labels in mixed spellings. Two hold a vocabulary of 501 labels, past the ceiling, so no new tag may be offered. Three hold nothing a tag can rest on. |
| `sessions/` | 10 | An English transcript (`kind` `session`), one turn a line, with the tags of its report in `report`. Two report a tag whose quote is not in the text, which the quote check must drop. |
| `sensitive/` | 10 | English sentences naming a health matter, a belief, a party, a union, an origin, an immigration status, a criminal matter or a genetic test, and invented people by full name. Each of those words and names is in `mustNot`. Three hold one sensitive label and one name among the labels the person typed. |
| `languages/` | 10 | One text in each of Spanish, French, German, Portuguese, Japanese, Chinese, Korean, Arabic, Hindi and Russian. `expected.new` is empty, and the vocabulary holds one key the text holds. |
| `injection/` | 5 | An English document with a passage that asks a model for a tag: in a heading, mid-paragraph, in a quoted block, as a comment line, and split across two lines. The asked tag is in `asks`. |
| `bytes/` | 4 | Texts an estimate of tokens by characters undercounts: symbols alone, a script of three bytes a character, characters of four bytes, and long identifiers. Each carries 150 labels of 40 code points. |

`label-cases.json` holds 40 cases of the label check: a label, the quotes it would rest on, whether the quotes hold it
(`held`) and why (`why`).

## The shape of a file

Each file is one JSON object named by its `id` (`plain/plain-budget-review.json` holds `"id": "plain-budget-review"`),
and `set` names its folder:

```json
{
  "id": "plain-budget-review",
  "set": "plain",
  "kind": "document",
  "language": "en",
  "title": "Q3 budget review",
  "headings": ["Summary", "Hiring plan"],
  "path": null,
  "text": "The whole text.",
  "vocabulary": [{ "label": "budget", "uses": 4, "lastUsed": 1762300800000 }],
  "typed": ["budget"],
  "expected": { "existing": ["budget"], "new": ["hiring"] },
  "mustNot": [],
  "asks": []
}
```

- `language` is the language detector's ISO 639-1 code for the text (`en`, `es`, `zh` and so on).
- `vocabulary` holds the labels the person has used, in their own spelling, with how many items hold each and when one
  last did (milliseconds since 1970, or `null`). `typed` holds the labels they typed themselves.
- `expected.existing` and `expected.new` are keys in `tagKey`'s form (`Q3 Planning` is `q3planning`): the tags a good
  answer holds from the vocabulary and new.
- `mustNot` holds words and names no step may propose as a new tag; each stands in the text.
- `asks` holds the tag an injection fixture's text asks for; it stands in the text and in neither expected list.
- `report`, in a session alone, holds the report's tags, each `{ "label": "...", "quotes": ["..."] }`.

The schema is `TagFixture` in the loader. It is strict: a member it does not name fails the parse.

## Adding a case

1. Write a new text. Do not paste a real document, message or transcript, and do not use a real person's name, an
   email address, a telephone number or a long run of digits; `tags.fixtures.test.ts` refuses the last three.
2. Save it as `<set>/<id>.json` with the shape above.
3. Each set holds a fixed number of files, which `tags.fixtures.test.ts` checks. A new case in a set changes that number
   there and in `TAG_FIXTURE_SETS` in the loader, in the same change.

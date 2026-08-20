# aidep-registry

The deprecation registry behind [aidep](../aidep): every OpenAI, Anthropic, and Google model and API deprecation as reviewable JSON, kept current by a daily poller whose output is a pull request, not a database write.

- `registry/{openai,anthropic,google}.json`: the data. One row per deprecation event: ids to grep for, status, announced/dies dates, replacement, migration link. Schema in `src/schema.ts`.
- `src/parsers/`: one parser per provider page. OpenAI and Anthropic serve markdown (`.md` URLs); Google is HTML (cheerio). Every parser quirk that has actually been observed has a fixture in `test/fixtures/`, including the U+2011 non-breaking hyphens in OpenAI date cells and the localized page variant Google intermittently serves.
- `src/poller.ts`: fetch → hash short-circuit → parse → diff against the stored JSON → write changed rows and a PR body. Parser-owned fields (status, dates, replacement) update from the page; hand-owned fields (`api_ids`, `replacement_notes`, `migration_url`) survive. A parse returning zero rows for a provider that has rows is treated as a fetch anomaly, never as a mass removal.
- `src/liveness.ts`: daily diff of the providers' live `/v1/models` lists (own keys, optional) flips deprecated → retired when an id actually disappears.
- `src/tripwire.ts`: cross-check against benchr.org's free deprecations API (with attribution, per their terms). Alert-only; provider pages are the source of record.

## Run

```sh
npm ci
npm test          # parser fixtures + poller/liveness/tripwire
npm run poll:dry  # live dry-run against the three provider pages
node src/seed.ts  # regenerate registry/*.json from the fixtures
```

`.github/workflows/poll.yml` runs the poller daily and opens a review PR when anything changed; merging the PR is the human approval. Provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) as repo secrets enable the liveness check; without them it is skipped.

v1 scope: first-party APIs only. Bedrock and Vertex run their own retirement calendars for the same models.

## Licence

Code is MIT (`LICENSE`). **The registry data in `registry/*.json` is CC0** (`registry/LICENSE`):
public domain, no attribution required, no share-alike. Point your own agent, tool or CI at it and
do whatever you like with it. Every row carries the vendor `source_url` it came from and the
`verified_at` date it was last checked, so you can audit any claim in it without trusting us.

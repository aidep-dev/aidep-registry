# aidep-registry

## Commands

- `npm test` is vitest, not jest. `npm run typecheck` is `tsc --noEmit`. No database, no network in the suite.
- `npm run poll:dry` hits the three live provider pages and writes nothing.

## registry/*.json is generated

- `registry/{openai,anthropic,google}.json` is output, not source. `src/seed.ts` regenerates it from the fixtures in `test/fixtures/`. Never hand-edit a row.
- To change a row, change the parser or the fixture, then `node src/seed.ts` and commit both.
- The app repo mirrors the row schema in its `src/registry.ts`. A field change here has to land there too.

## Parsers

- Every real-world quirk observed on a provider page gets a fixture. Already captured: U+2011 non-breaking hyphens in OpenAI date cells; the localized page variant Google intermittently serves (`google-deprecations-ja.html`); MDX tags (`<Note>`, `<Warning>`) interleaved with Anthropic's markdown tables; column matching by header name rather than position, so an inserted column does not shift the parse.
- A new quirk without a fixture is a regression waiting to happen. Add the fixture in the same change.

## Poller

- The poller never auto-merges. It opens a review PR; a human merging that PR is the approval step. Do not add an auto-merge path.
- A parse returning zero rows for a provider that currently has rows is a fetch or page-shape anomaly, never a mass removal. The poller records an anomaly, skips that source, and leaves the stored rows and the stored page hash alone.
- Rows present in the registry but gone from the page are kept and flagged for review, never auto-deleted.
- Parser-owned fields (status, dates, replacement) update from the page. Hand-owned fields (`api_ids`, `replacement_notes`, `migration_url`) survive a poll.

## Scope

- v1 is first-party APIs only. Bedrock and Vertex run their own retirement calendars for the same models and are out of scope.

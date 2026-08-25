# Contributing

Rows come from vendor pages, never from memory or a model. Every row carries the `source_url`
that states the claim and a `verified_at` date; a change without a vendor page behind it does not
merge.

Two ways in:

- [File a row](../../issues/new?template=file-a-row.yml): the issue form asks for exactly the
  schema fields. Good for a missing deprecation or a wrong date.
- A PR editing `registry/{openai,anthropic,google}.json` directly. Schema is `src/schema.ts`;
  `npm test` validates every row. Parser-owned fields (status, dates, replacement) get overwritten
  by the daily poller, so a correction to those usually means the parser or the vendor page is
  wrong; say which in the PR.

Data is CC0, code is MIT. By contributing a row you agree it carries no rights: it is a fact with
a citation.

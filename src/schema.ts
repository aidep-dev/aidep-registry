import { z } from "zod";

export const ProviderSchema = z.enum(["openai", "anthropic", "google"]);
export const SurfaceSchema = z.enum(["model", "endpoint", "param", "header", "feature"]);
export const StatusSchema = z.enum(["legacy", "deprecated", "retired"]);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const RegistryRowSchema = z.object({
  // "provider:surface:slug", e.g. "openai:endpoint:assistants-api"
  id: z.string().regex(/^(openai|anthropic|google):(model|endpoint|param|header|feature):[a-z0-9][a-z0-9.-]*$/),
  provider: ProviderSchema,
  surface: SurfaceSchema,
  // exact strings to grep for in customer code; at least one
  api_ids: z.array(z.string().min(1)).min(1),
  status: StatusSchema,
  announced: isoDate.nullable(),
  dies: isoDate.nullable(),
  dies_is_earliest_possible: z.boolean(),
  replacement_id: z.string().nullable(),
  // config the replacement needs, e.g. "reasoning.mode: pro" or "omit temperature/top_p/top_k"
  replacement_notes: z.string().nullable(),
  migration_url: z.url().nullable(),
  source_url: z.url(),
  verified_at: isoDate,
  // v1 scopes to first-party APIs only; Bedrock/Vertex run their own calendars
  platform: z.literal("first-party"),
});

export type Provider = z.infer<typeof ProviderSchema>;
export type Surface = z.infer<typeof SurfaceSchema>;
export type Status = z.infer<typeof StatusSchema>;
export type RegistryRow = z.infer<typeof RegistryRowSchema>;

export const RegistryFileSchema = z.array(RegistryRowSchema);

/**
 * Every parser exposes the same shape: raw page bytes in, validated rows out.
 * Parsers are pure (no fetching) so the poller and tests inject fixtures.
 */
export type Parser = (raw: string, opts: { verifiedAt: string }) => RegistryRow[];

export function validateRows(rows: unknown): RegistryRow[] {
  return RegistryFileSchema.parse(rows);
}

/** Stable sort so registry JSON diffs are minimal and reviewable. */
export function sortRows(rows: RegistryRow[]): RegistryRow[] {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}

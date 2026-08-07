// Error codes that mean "this feature's migration has not run yet".
//
// Deliberately a LEAF module — no imports at all. The lifecycle paths (account
// deletion, SAR export) need this predicate, and importing it from a feature
// seam would drag that seam's whole dependency graph into them (and, via
// lib/access.ts, form an import cycle).
//
// Measured against PostgREST 14.16 in a local container (07/08/2026 — see
// docs/DURABLE_LESSONS.md 2026-08-07). The four codes are NOT
// interchangeable:
//
//   | Situation                                  | HTTP | code       |
//   |--------------------------------------------|------|------------|
//   | Missing TABLE                              | 404  | PGRST205   |
//   | Missing column in a FILTER                 | 400  | 42703      |
//   | Missing column in an INSERT/UPDATE PAYLOAD | 400  | PGRST204   |
//
// PGRST205 is the one that actually fires on a Supabase-backed deployment:
// PostgREST answers an unknown table from its own schema cache and never
// reaches Postgres, so the classic 42P01 (`undefined_table`) never appears.
// 42P01 is retained for direct-Postgres / pre-12.2 self-hosters.

/** Missing table, in either the PostgREST or the raw-Postgres shape. */
export const MISSING_TABLE_CODES = ["PGRST205", "42P01"] as const;

/** Missing column, in either the filter or the write-payload shape. */
export const MISSING_COLUMN_CODES = ["42703", "PGRST204"] as const;

const UNMIGRATED_CODES = new Set<string>([
  ...MISSING_TABLE_CODES,
  ...MISSING_COLUMN_CODES,
]);

/**
 * True when a Supabase/Postgres error means the relation or column simply is
 * not there yet — i.e. the caller should degrade to "feature unavailable"
 * rather than fail. Any other error (permissions, constraint violations,
 * connectivity) returns false and must keep its existing failure behaviour.
 */
export function isUnmigratedSchemaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && UNMIGRATED_CODES.has(code);
}

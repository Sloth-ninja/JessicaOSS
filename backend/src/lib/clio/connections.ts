// Per-user Clio OAuth token storage (table `user_clio_connections`, migration
// 20260803_01). One row per (user, product). Tokens are AES-256-GCM encrypted
// with the shared apiKeyCrypto scheme (REUSED, not duplicated).
//
// Degradation contract: every read/write tolerates an unmigrated database
// (Postgres 42P01 undefined_table / 42703 undefined_column) by treating the
// feature as UNAVAILABLE — loads return null, connected-product checks return
// all-false — never throwing. This mirrors the deletion-governance seam so the
// connector is inert until the owner runs the migration in production.
//
// Rotation atomicity (Grow): Grow refresh tokens rotate on EVERY use, so a
// refreshed token set MUST be persisted before the new access token is used. A
// lost rotation strands the connection. `persistRefreshedTokens` writes with an
// id predicate + select-back and treats zero returned rows as a hard failure so
// the caller can surface an error rather than proceed on a token it failed to
// save (see docs/DURABLE_LESSONS.md — encode state transitions in the predicate).

import {
  decryptApiKey,
  encryptApiKey,
  type EncryptedKeyFields,
} from "../apiKeyCrypto";
import { createServerSupabase } from "../supabase";
import { safeErrorLog } from "../safeError";
import type { ClioProduct } from "./config";

type Db = ReturnType<typeof createServerSupabase>;

export interface ClioTokens {
  accessToken: string;
  /** Manage refresh tokens are long-lived; Grow's rotate on every use. */
  refreshToken: string | null;
  /** Absolute expiry of the access token, or null if unknown. */
  expiresAt: Date | null;
  scope: string | null;
}

export interface ClioConnection {
  id: string;
  userId: string;
  product: ClioProduct;
  tokens: ClioTokens;
  clioUserId: string | null;
  clioUserName: string | null;
}

interface ClioConnectionRow {
  id: string;
  user_id: string;
  product: ClioProduct;
  encrypted_access_token: string | null;
  access_token_iv: string | null;
  access_token_tag: string | null;
  encrypted_refresh_token: string | null;
  refresh_token_iv: string | null;
  refresh_token_tag: string | null;
  token_expires_at: string | null;
  scope: string | null;
  clio_user_id: string | null;
  clio_user_name: string | null;
}

/**
 * True when a Supabase error means the connector table/columns are not yet
 * migrated. Callers degrade to "feature unavailable" rather than erroring.
 */
export function isClioSchemaMissing(
  error:
    | {
        code?: string | null;
      }
    | null
    | undefined,
): boolean {
  return error?.code === "42P01" || error?.code === "42703";
}

function decryptField(
  encrypted: string | null,
  iv: string | null,
  tag: string | null,
  tag_context: string,
): string | null {
  if (!encrypted || !iv || !tag) return null;
  const fields: EncryptedKeyFields = {
    encrypted_key: encrypted,
    iv,
    auth_tag: tag,
  };
  return decryptApiKey(fields, (err) =>
    console.error(
      `[clio/connections] decrypt failed (${tag_context})`,
      safeErrorLog(err),
    ),
  );
}

function rowToConnection(row: ClioConnectionRow): ClioConnection | null {
  const accessToken = decryptField(
    row.encrypted_access_token,
    row.access_token_iv,
    row.access_token_tag,
    "access",
  );
  if (!accessToken) return null;
  const refreshToken = decryptField(
    row.encrypted_refresh_token,
    row.refresh_token_iv,
    row.refresh_token_tag,
    "refresh",
  );
  return {
    id: row.id,
    userId: row.user_id,
    product: row.product,
    tokens: {
      accessToken,
      refreshToken,
      expiresAt: row.token_expires_at ? new Date(row.token_expires_at) : null,
      scope: row.scope,
    },
    clioUserId: row.clio_user_id,
    clioUserName: row.clio_user_name,
  };
}

/**
 * Encrypt a token value into the connector column triplet (or null-out all
 * three when the value is absent — mirrors the MCP `tokenSecretPatch`).
 */
function tokenColumns(
  prefix: "access_token" | "refresh_token",
  value: string | null | undefined,
): Record<string, string | null> {
  if (!value) {
    return {
      [`encrypted_${prefix}`]: null,
      [`${prefix}_iv`]: null,
      [`${prefix}_tag`]: null,
    };
  }
  const enc = encryptApiKey(value);
  return {
    [`encrypted_${prefix}`]: enc.encrypted_key,
    [`${prefix}_iv`]: enc.iv,
    [`${prefix}_tag`]: enc.auth_tag,
  };
}

/**
 * Load a decrypted connection for (user, product), or null when absent,
 * unmigrated, or undecryptable. Never throws for the schema-missing case.
 */
export async function loadClioConnection(
  db: Db,
  userId: string,
  product: ClioProduct,
): Promise<ClioConnection | null> {
  const { data, error } = await db
    .from("user_clio_connections")
    .select("*")
    .eq("user_id", userId)
    .eq("product", product)
    .maybeSingle();
  if (error) {
    if (isClioSchemaMissing(error)) return null;
    throw error;
  }
  if (!data) return null;
  return rowToConnection(data as ClioConnectionRow);
}

export interface SaveClioConnectionInput {
  userId: string;
  product: ClioProduct;
  tokens: ClioTokens;
  clioUserId?: string | null;
  clioUserName?: string | null;
}

/**
 * Upsert a connection on the (user_id, product) unique key. Used on first
 * connect (and reconnect). Returns the persisted, decrypted connection.
 */
export async function saveClioConnection(
  db: Db,
  input: SaveClioConnectionInput,
): Promise<ClioConnection> {
  const now = new Date().toISOString();
  const row = {
    user_id: input.userId,
    product: input.product,
    ...tokenColumns("access_token", input.tokens.accessToken),
    ...tokenColumns("refresh_token", input.tokens.refreshToken),
    token_expires_at: input.tokens.expiresAt
      ? input.tokens.expiresAt.toISOString()
      : null,
    scope: input.tokens.scope ?? null,
    clio_user_id: input.clioUserId ?? null,
    clio_user_name: input.clioUserName ?? null,
    updated_at: now,
  };
  const { data, error } = await db
    .from("user_clio_connections")
    .upsert(row, { onConflict: "user_id,product" })
    .select("*")
    .single();
  if (error) throw error;
  const connection = rowToConnection(data as ClioConnectionRow);
  if (!connection) {
    throw new Error("Saved Clio connection could not be read back.");
  }
  return connection;
}

/**
 * Atomically persist a refreshed token set for an existing connection row.
 *
 * Writes by id predicate and selects the row back; zero returned rows (row
 * gone, or the write silently affected nothing) is treated as a hard failure
 * so a Grow rotation that failed to persist is surfaced rather than swallowed —
 * the caller must NOT use the new access token if this throws (the OLD stored
 * refresh values remain, unchanged by a failed/zero-row update). `clioUserId`
 * and name are preserved (not overwritten) on a token-only refresh.
 */
export async function persistRefreshedTokens(
  db: Db,
  connectionId: string,
  tokens: ClioTokens,
): Promise<ClioConnection> {
  const patch = {
    ...tokenColumns("access_token", tokens.accessToken),
    ...tokenColumns("refresh_token", tokens.refreshToken),
    token_expires_at: tokens.expiresAt ? tokens.expiresAt.toISOString() : null,
    scope: tokens.scope ?? null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from("user_clio_connections")
    .update(patch)
    .eq("id", connectionId)
    .select("*");
  if (error) throw error;
  const rows = (data as ClioConnectionRow[] | null) ?? [];
  if (rows.length !== 1) {
    throw new Error(
      "Failed to persist refreshed Clio tokens — connection not updated.",
    );
  }
  const connection = rowToConnection(rows[0]);
  if (!connection) {
    throw new Error("Refreshed Clio connection could not be read back.");
  }
  return connection;
}

/**
 * Delete the (user, product) connection row. Best-effort local removal — the
 * caller performs any remote deauthorize separately (disconnect must still
 * clear local state even if the remote revoke fails). No-op / non-throwing on
 * an unmigrated database.
 */
export async function deleteClioConnection(
  db: Db,
  userId: string,
  product: ClioProduct,
): Promise<void> {
  const { error } = await db
    .from("user_clio_connections")
    .delete()
    .eq("user_id", userId)
    .eq("product", product);
  if (error && !isClioSchemaMissing(error)) throw error;
}

export interface ClioConnectionSummary {
  connected: boolean;
  clioUserName: string | null;
}

export interface ClioConnectionSummaries {
  manage: ClioConnectionSummary;
  grow: ClioConnectionSummary;
}

/**
 * Per-product connection summary (connected flag + stored display name) WITHOUT
 * decrypting any token — cheap enough for the status route and never dependent
 * on Clio being reachable. 42P01/42703-tolerant (all-disconnected when
 * unmigrated).
 */
export async function getClioConnectionSummaries(
  db: Db,
  userId: string,
): Promise<ClioConnectionSummaries> {
  const empty: ClioConnectionSummaries = {
    manage: { connected: false, clioUserName: null },
    grow: { connected: false, clioUserName: null },
  };
  const { data, error } = await db
    .from("user_clio_connections")
    .select("product, clio_user_name, encrypted_access_token")
    .eq("user_id", userId);
  if (error) {
    if (isClioSchemaMissing(error)) return empty;
    throw error;
  }
  const rows =
    (data as Array<{
      product: ClioProduct;
      clio_user_name: string | null;
      encrypted_access_token: string | null;
    }>) ?? [];
  const result: ClioConnectionSummaries = {
    manage: { connected: false, clioUserName: null },
    grow: { connected: false, clioUserName: null },
  };
  for (const row of rows) {
    if (row.product !== "manage" && row.product !== "grow") continue;
    result[row.product] = {
      connected: !!row.encrypted_access_token,
      clioUserName: row.clio_user_name,
    };
  }
  return result;
}

export interface ClioConnectedProducts {
  manage: boolean;
  grow: boolean;
}

/**
 * Which products the user has a stored connection for. Cheap existence check
 * (no decryption) for the profile payload and status route. Returns all-false
 * on an unmigrated database (42P01/42703-tolerant) — never throws for that.
 */
export async function listConnectedProducts(
  db: Db,
  userId: string,
): Promise<ClioConnectedProducts> {
  const { data, error } = await db
    .from("user_clio_connections")
    .select("product, encrypted_access_token")
    .eq("user_id", userId);
  if (error) {
    if (isClioSchemaMissing(error)) return { manage: false, grow: false };
    throw error;
  }
  const rows =
    (data as Array<{
      product: ClioProduct;
      encrypted_access_token: string | null;
    }>) ?? [];
  return {
    manage: rows.some(
      (r) => r.product === "manage" && !!r.encrypted_access_token,
    ),
    grow: rows.some((r) => r.product === "grow" && !!r.encrypted_access_token),
  };
}

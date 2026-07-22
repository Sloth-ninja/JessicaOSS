import crypto from "crypto";

/**
 * Shared AES-256-GCM crypto for provider API keys.
 *
 * Extracted verbatim from userApiKeys.ts (scheme unchanged) so firm-level keys
 * (organisation_api_keys) encrypt with the exact same key derivation and cipher
 * as personal keys (user_api_keys). The user-key logic itself was not moved —
 * userApiKeys.ts keeps its own thin wrappers around these.
 */

export type EncryptedKeyFields = {
    encrypted_key: string;
    iv: string;
    auth_tag: string;
};

function encryptionKey(): Buffer {
    const secret = process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error("USER_API_KEYS_ENCRYPTION_SECRET is not configured");
    }
    return crypto.scryptSync(secret, "mike-user-api-keys-v1", 32);
}

export function encryptApiKey(value: string): EncryptedKeyFields {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
    ]);
    return {
        encrypted_key: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        auth_tag: cipher.getAuthTag().toString("base64"),
    };
}

/**
 * Decrypt a stored key. Returns null (never throws) on any failure — a corrupt
 * or wrong-secret row must degrade to "no key" rather than break the request.
 * `onError` lets the caller log with its own scoped tag (raw errors never reach
 * users).
 */
export function decryptApiKey(
    row: EncryptedKeyFields,
    onError?: (error: unknown) => void,
): string | null {
    try {
        const decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            encryptionKey(),
            Buffer.from(row.iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(row.encrypted_key, "base64")),
            decipher.final(),
        ]);
        return decrypted.toString("utf8");
    } catch (err) {
        onError?.(err);
        return null;
    }
}

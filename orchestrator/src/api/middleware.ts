import { createHash, randomBytes } from "crypto";
import { SignJWT, jwtVerify, generateKeyPair, exportJWK, importJWK } from "jose";
import type { JWK } from "jose";
import { config } from "../config.js";
import * as dbQueries from "../../../database/queries.js";
import type { User } from "../../../database/schema.js";

/**
 * Authentication Middleware for ANTP Orchestrator.
 *
 * Supports two authentication methods:
 * 1. JWT Bearer tokens (from login) — ECDSA ES256 signed
 * 2. API Key tokens (for programmatic access) — SHA-256 hashed lookup
 *
 * JWT uses ECDSA P-256 (ES256) for strong asymmetric signing.
 * Keys are auto-generated on first startup and cached in memory.
 * For production persistence, set JWT_PRIVATE_KEY and JWT_PUBLIC_KEY env vars.
 */

// ──────────────────────────────────────────────
// Key Management (ECDSA P-256)
// ──────────────────────────────────────────────

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let keysReady = false;

/**
 * Initialize ECDSA key pair.
 * Tries env vars first, falls back to auto-generation.
 */
export async function initializeKeys(): Promise<void> {
  const privJwkStr = process.env.JWT_PRIVATE_KEY;
  const pubJwkStr = process.env.JWT_PUBLIC_KEY;

  if (privJwkStr && pubJwkStr) {
    try {
      const privJwk: JWK = JSON.parse(privJwkStr);
      const pubJwk: JWK = JSON.parse(pubJwkStr);
      privateKey = (await importJWK(privJwk, "ES256")) as CryptoKey;
      publicKey = (await importJWK(pubJwk, "ES256")) as CryptoKey;
      console.log("[Auth] Loaded ECDSA keys from environment");
    } catch (err) {
      console.error("[Auth] Failed to load keys from env:", err);
      await generateNewKeys();
    }
  } else {
    await generateNewKeys();
  }

  keysReady = true;
}

async function generateNewKeys(): Promise<void> {
  const keyPair = await generateKeyPair("ES256");
  privateKey = keyPair.privateKey;
  publicKey = keyPair.publicKey;

  // Export for user to save in env vars
  const privJwk = await exportJWK(privateKey);
  const pubJwk = await exportJWK(publicKey);

  console.log("[Auth] ⚠️  Generated new ECDSA key pair.");
  console.log("[Auth] For production, set these environment variables:");
  console.log(`  JWT_PRIVATE_KEY='${JSON.stringify(privJwk)}'`);
  console.log(`  JWT_PUBLIC_KEY='${JSON.stringify(pubJwk)}'`);
}

// ──────────────────────────────────────────────
// JWT Operations
// ──────────────────────────────────────────────

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
}

/** Sign a JWT token with ECDSA ES256. */
export async function signJwt(payload: JwtPayload): Promise<string> {
  if (!keysReady) throw new Error("Auth keys not initialized");

  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .setIssuer("antp-orchestrator")
    .setSubject(payload.userId)
    .sign(privateKey);
}

/** Verify and decode a JWT token. */
export async function verifyJwt(token: string): Promise<JwtPayload | null> {
  if (!keysReady) return null;

  try {
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: "antp-orchestrator",
    });

    return {
      userId: payload.userId as string,
      email: payload.email as string,
      role: payload.role as string,
    };
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// API Key Helpers
// ──────────────────────────────────────────────

/** Generate a new API key (returns raw key — shown once to user). */
export function generateApiKey(): {
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
} {
  const rawKey = `antp_${randomBytes(32).toString("hex")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.substring(0, 12);

  return { rawKey, keyHash, keyPrefix };
}

/** Hash an API key for lookup. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

// ──────────────────────────────────────────────
// Request Authentication
// ──────────────────────────────────────────────

export interface AuthResult {
  user: User;
  method: "jwt" | "api_key";
}

/**
 * Authenticate a request by reading the Authorization header.
 *
 * Supports:
 * - Bearer <jwt_token>
 * - ApiKey <antp_xxxxx>
 *
 * Returns the authenticated user or null.
 */
export async function authenticateRequest(
  authHeader: string | undefined
): Promise<AuthResult | null> {
  if (!authHeader) return null;

  // Try JWT Bearer token
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const payload = await verifyJwt(token);
    if (!payload) return null;

    const user = await dbQueries.getUserById(payload.userId);
    if (!user) return null;

    return { user, method: "jwt" };
  }

  // Try API Key
  if (authHeader.startsWith("ApiKey ")) {
    const rawKey = authHeader.slice(7);
    const keyHash = hashApiKey(rawKey);
    const keyRecord = await dbQueries.getApiKeyByHash(keyHash);
    if (!keyRecord || !keyRecord.user) return null;

    return { user: keyRecord.user as User, method: "api_key" };
  }

  return null;
}

// ──────────────────────────────────────────────
// Rate Limiting (in-memory)
// ──────────────────────────────────────────────

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

/** Check if an IP is rate-limited for login attempts. */
export function isRateLimited(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;

  if (Date.now() > entry.resetAt) {
    loginAttempts.delete(ip);
    return false;
  }

  return entry.count >= 5;
}

/** Record a login attempt from an IP. */
export function recordLoginAttempt(ip: string): void {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() > entry.resetAt) {
    loginAttempts.set(ip, {
      count: 1,
      resetAt: Date.now() + 15 * 60 * 1000, // 15 minutes
    });
  } else {
    entry.count++;
  }
}

/** Reset login attempts after successful login. */
export function resetLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

// Periodic cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 300_000);

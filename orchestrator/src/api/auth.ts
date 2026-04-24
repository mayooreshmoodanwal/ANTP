import type { TemplatedApp, HttpResponse, HttpRequest } from "uWebSockets.js";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { Resend } from "resend";
import { config } from "../config.js";
import * as dbQueries from "../../../database/queries.js";
import {
  signJwt,
  authenticateRequest,
  generateApiKey,
  isRateLimited,
  recordLoginAttempt,
  resetLoginAttempts,
} from "./middleware.js";

/**
 * Authentication REST API endpoints.
 *
 * - POST /api/auth/signup     — Create account + send verification email
 * - POST /api/auth/login      — Authenticate and receive JWT
 * - POST /api/auth/verify     — Verify email with token
 * - GET  /api/auth/me         — Get current user profile
 * - POST /api/auth/api-keys   — Generate API key
 * - GET  /api/auth/api-keys   — List user's API keys
 * - DELETE /api/auth/api-keys/:id — Revoke API key
 * - POST /api/auth/pair-node  — Link a node via pairing code
 */

// Initialize Resend for email delivery
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const BCRYPT_ROUNDS = 12;
const VERIFICATION_EXPIRY_HOURS = 24;
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://antp-dashboard.vercel.app";

export function registerAuthApi(app: TemplatedApp): void {
  // ── Signup ──
  app.post("/api/auth/signup", (res, req) => {
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    readJson(res, req, async (body: any) => {
      if (aborted) return;

      try {
        // Validate input
        if (!body?.email || !body?.password || !body?.name) {
          jsonResponse(res, 400, {
            error: "Missing required fields: email, password, name",
          });
          return;
        }

        const email = body.email.toLowerCase().trim();
        const { password, name, role } = body;

        // Email format validation
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          jsonResponse(res, 400, { error: "Invalid email format" });
          return;
        }

        // Password strength
        if (password.length < 8) {
          jsonResponse(res, 400, {
            error: "Password must be at least 8 characters",
          });
          return;
        }

        // Check existing user
        const existing = await dbQueries.getUserByEmail(email);
        if (existing) {
          jsonResponse(res, 409, { error: "Email already registered" });
          return;
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

        // Generate 6-digit OTP verification token
        const verificationToken = Math.floor(100000 + Math.random() * 900000).toString();
        const verificationExpiresAt = new Date(
          Date.now() + VERIFICATION_EXPIRY_HOURS * 60 * 60 * 1000
        );

        // Validate role
        const validRoles = ["DEVELOPER", "NODE_PROVIDER"] as const;
        const userRole = validRoles.includes(role) ? role : "DEVELOPER";

        // Create user
        const user = await dbQueries.createUser({
          email,
          passwordHash,
          name,
          role: userRole,
          isVerified: false,
          verificationToken,
          verificationExpiresAt,
        });

        // Send verification email via Resend
        if (resend) {
          try {
            await resend.emails.send({
              from: process.env.RESEND_FROM || "ANTP <onboarding@resend.dev>",
              to: email,
              subject: "Verify your ANTP account",
              html: `
                <div style="font-family: 'Inter', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0a0e17; color: #e8ecf4; border-radius: 12px;">
                  <h1 style="color: #3b82f6; font-size: 24px; margin-bottom: 8px;">Welcome to ANTP</h1>
                  <p style="color: #8b95b0; font-size: 14px; margin-bottom: 24px;">Decentralized Edge-Compute Platform</p>
                  <p style="font-size: 14px; line-height: 1.6;">Hi ${name},</p>
                  <p style="font-size: 14px; line-height: 1.6;">Use the following Verification Code to activate your account:</p>
                  <div style="background: #111827; padding: 16px; border-radius: 8px; text-align: center; margin: 24px 0;">
                    <span style="font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #3b82f6;">${verificationToken}</span>
                  </div>
                  <p style="font-size: 12px; color: #5a6380; margin-top: 24px;">This code expires in 24 hours. If you didn't create this account, ignore this email.</p>
                </div>
              `,
            });
            console.log(`[Auth] Verification OTP sent to ${email}`);
          } catch (err) {
            console.error("[Auth] Failed to send verification email:", err);
          }
        } else {
          console.log(`[Auth] No RESEND_API_KEY — verification OTP: ${verificationToken}`);
        }

        if (!aborted) {
          jsonResponse(res, 201, {
            email: user.email,
            message: resend
              ? "Account created. Check your email for the verification code."
              : "Account created. Check console logs for your OTP.",
          });
        }
      } catch (err: any) {
        console.error("[Auth] Signup error:", err);
        if (!aborted) jsonResponse(res, 500, { error: "Internal server error" });
      }
    });
  });

  // ── Login ──
  app.post("/api/auth/login", (res, req) => {
    let aborted = false;
    const ip = Buffer.from(res.getRemoteAddressAsText()).toString();
    res.onAborted(() => { aborted = true; });

    readJson(res, req, async (body: any) => {
      if (aborted) return;

      try {
        // Rate limiting
        if (isRateLimited(ip)) {
          jsonResponse(res, 429, {
            error: "Too many login attempts. Try again in 15 minutes.",
          });
          return;
        }

        if (!body?.email || !body?.password) {
          jsonResponse(res, 400, {
            error: "Missing required fields: email, password",
          });
          return;
        }

        const email = body.email.toLowerCase().trim();
        recordLoginAttempt(ip);

        const user = await dbQueries.getUserByEmail(email);
        if (!user) {
          jsonResponse(res, 401, { error: "Invalid email or password" });
          return;
        }

        // Check account lock
        if (user.lockedUntil && user.lockedUntil > new Date()) {
          const remaining = Math.ceil(
            (user.lockedUntil.getTime() - Date.now()) / 60000
          );
          jsonResponse(res, 423, {
            error: `Account locked. Try again in ${remaining} minutes.`,
          });
          return;
        }

        // Verify password
        const validPassword = await bcrypt.compare(
          body.password,
          user.passwordHash
        );
        if (!validPassword) {
          const attempts = await dbQueries.incrementFailedLogin(user.id);
          // Lock after 5 failed attempts
          if (attempts >= 5) {
            const lockUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 min
            await dbQueries.lockUser(user.id, lockUntil);
          }
          jsonResponse(res, 401, { error: "Invalid email or password" });
          return;
        }

        // Check email verification
        if (!user.isVerified) {
          jsonResponse(res, 403, {
            error: "Email not verified. Check your inbox for the verification code.",
            needsVerification: true,
            email: user.email,
          });
          return;
        }

        // Success — reset attempts and generate JWT
        await dbQueries.resetFailedLogin(user.id);
        resetLoginAttempts(ip);

        const token = await signJwt({
          userId: user.id,
          email: user.email,
          role: user.role,
        });

        if (!aborted) {
          jsonResponse(res, 200, {
            token,
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              role: user.role,
              linkedNodeId: user.linkedNodeId,
              createdAt: user.createdAt,
            },
          });
        }
      } catch (err: any) {
        console.error("[Auth] Login error:", err);
        if (!aborted) jsonResponse(res, 500, { error: "Internal server error" });
      }
    });
  });

  // ── Verify Email (OTP) ──
  app.post("/api/auth/verify", (res, req) => {
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    readJson(res, req, async (body: any) => {
      if (aborted) return;
      try {
        if (!body?.email || !body?.otp) {
          jsonResponse(res, 400, { error: "Missing email or OTP code" });
          return;
        }

        const user = await dbQueries.verifyUserEmail(body.email, body.otp);
        if (!user) {
          jsonResponse(res, 400, {
            error: "Invalid or expired verification code",
          });
          return;
        }

        // Auto-login after verification
        const token = await signJwt({
          userId: user.id,
          email: user.email,
          role: user.role,
        });

        if (!aborted) {
          jsonResponse(res, 200, {
            message: "Email verified successfully",
            token,
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              role: user.role,
            },
          });
        }
      } catch (err: any) {
        console.error("[Auth] Verify error:", err);
        if (!aborted) jsonResponse(res, 500, { error: "Internal server error" });
      }
    });
  });

  // ── Get Current User ──
  app.get("/api/auth/me", async (res, req) => {
    const authHeader = req.getHeader("authorization");
    res.onAborted(() => {});

    try {
      const auth = await authenticateRequest(authHeader);
      if (!auth) {
        jsonResponse(res, 401, { error: "Unauthorized" });
        return;
      }

      const user = auth.user;
      const taskStats = await dbQueries.getUserTaskStats(user.id);

      // Get linked node info if NODE_PROVIDER
      let linkedNode = null;
      if (user.linkedNodeId) {
        linkedNode = await dbQueries.getNodeByNodeId(user.linkedNodeId);
      }

      jsonResponse(res, 200, {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        isVerified: user.isVerified,
        linkedNodeId: user.linkedNodeId,
        linkedNode: linkedNode
          ? {
              nodeId: linkedNode.nodeId,
              tier: linkedNode.tier,
              status: linkedNode.status,
              totalTasksCompleted: linkedNode.totalTasksCompleted,
              totalEarnings: linkedNode.totalEarnings,
              reputationScore: linkedNode.reputationScore,
              lastSeenAt: linkedNode.lastSeenAt,
            }
          : null,
        taskStats,
        createdAt: user.createdAt,
      });
    } catch (err: any) {
      jsonResponse(res, 500, { error: err.message });
    }
  });

  // ── Generate API Key ──
  app.post("/api/auth/api-keys", (res, req) => {
    const authHeader = req.getHeader("authorization");
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    readJson(res, req, async (body: any) => {
      if (aborted) return;

      try {
        const auth = await authenticateRequest(authHeader);
        if (!auth) {
          jsonResponse(res, 401, { error: "Unauthorized" });
          return;
        }

        const name = body?.name || "Default Key";
        const { rawKey, keyHash, keyPrefix } = generateApiKey();

        await dbQueries.createApiKey({
          userId: auth.user.id,
          keyHash,
          keyPrefix,
          name,
          permissions: { submitTask: true, readStats: true },
        });

        if (!aborted) {
          jsonResponse(res, 201, {
            key: rawKey, // ⚠️ Shown ONCE — never stored or retrievable
            prefix: keyPrefix,
            name,
            message: "Save this key now. It will not be shown again.",
          });
        }
      } catch (err: any) {
        console.error("[Auth] API key error:", err);
        if (!aborted) jsonResponse(res, 500, { error: err.message });
      }
    });
  });

  // ── List API Keys ──
  app.get("/api/auth/api-keys", async (res, req) => {
    const authHeader = req.getHeader("authorization");
    res.onAborted(() => {});

    try {
      const auth = await authenticateRequest(authHeader);
      if (!auth) {
        jsonResponse(res, 401, { error: "Unauthorized" });
        return;
      }

      const keys = await dbQueries.getUserApiKeys(auth.user.id);

      jsonResponse(res, 200, {
        keys: keys.map((k) => ({
          id: k.id,
          prefix: k.keyPrefix,
          name: k.name,
          permissions: k.permissions,
          lastUsedAt: k.lastUsedAt,
          createdAt: k.createdAt,
        })),
      });
    } catch (err: any) {
      jsonResponse(res, 500, { error: err.message });
    }
  });

  // ── Revoke API Key ──
  app.del("/api/auth/api-keys/:id", async (res, req) => {
    const authHeader = req.getHeader("authorization");
    const keyId = req.getParameter(0);
    res.onAborted(() => {});

    try {
      const auth = await authenticateRequest(authHeader);
      if (!auth) {
        jsonResponse(res, 401, { error: "Unauthorized" });
        return;
      }

      const success = await dbQueries.revokeApiKey(keyId, auth.user.id);
      if (!success) {
        jsonResponse(res, 404, { error: "API key not found" });
        return;
      }

      jsonResponse(res, 200, { message: "API key revoked" });
    } catch (err: any) {
      jsonResponse(res, 500, { error: err.message });
    }
  });

  // ── Pair Node ──
  app.post("/api/auth/pair-node", (res, req) => {
    const authHeader = req.getHeader("authorization");
    let aborted = false;
    res.onAborted(() => { aborted = true; });

    readJson(res, req, async (body: any) => {
      if (aborted) return;

      try {
        const auth = await authenticateRequest(authHeader);
        if (!auth) {
          jsonResponse(res, 401, { error: "Unauthorized" });
          return;
        }

        if (auth.user.role !== "NODE_PROVIDER" && auth.user.role !== "ADMIN") {
          jsonResponse(res, 403, {
            error: "Only NODE_PROVIDER accounts can pair nodes",
          });
          return;
        }

        if (!body?.code) {
          jsonResponse(res, 400, { error: "Missing pairing code" });
          return;
        }

        const pairing = await dbQueries.usePairingCode(
          body.code.toUpperCase(),
          auth.user.id
        );

        if (!pairing) {
          jsonResponse(res, 400, {
            error: "Invalid or expired pairing code",
          });
          return;
        }

        // Link node to user
        await dbQueries.linkNodeToUser(auth.user.id, pairing.nodeId);

        if (!aborted) {
          jsonResponse(res, 200, {
            message: "Node paired successfully",
            nodeId: pairing.nodeId,
          });
        }
      } catch (err: any) {
        console.error("[Auth] Pairing error:", err);
        if (!aborted) jsonResponse(res, 500, { error: err.message });
      }
    });
  });

  // ── My Tasks (paginated) ──
  app.get("/api/my/tasks", async (res, req) => {
    const authHeader = req.getHeader("authorization");
    const query = req.getQuery();
    res.onAborted(() => {});

    try {
      const auth = await authenticateRequest(authHeader);
      if (!auth) {
        jsonResponse(res, 401, { error: "Unauthorized" });
        return;
      }

      const params = new URLSearchParams(query);
      const limit = Math.min(parseInt(params.get("limit") || "20"), 100);
      const offset = parseInt(params.get("offset") || "0");

      const tasks = await dbQueries.getUserTasks(auth.user.id, limit, offset);
      const stats = await dbQueries.getUserTaskStats(auth.user.id);

      jsonResponse(res, 200, { tasks, stats, limit, offset });
    } catch (err: any) {
      jsonResponse(res, 500, { error: err.message });
    }
  });

  // ── My Earnings (Node Provider) ──
  app.get("/api/my/earnings", async (res, req) => {
    const authHeader = req.getHeader("authorization");
    res.onAborted(() => {});

    try {
      const auth = await authenticateRequest(authHeader);
      if (!auth) {
        jsonResponse(res, 401, { error: "Unauthorized" });
        return;
      }

      if (!auth.user.linkedNodeId) {
        jsonResponse(res, 200, {
          earnings: { unpaidBalance: 0, totalEarned: 0, taskCount: 0, history: [] },
          message: "No node linked. Pair a node to start earning.",
        });
        return;
      }

      const { getNodeEarnings } = await import("../economics/payout.js");
      const earnings = await getNodeEarnings(auth.user.linkedNodeId);

      jsonResponse(res, 200, { earnings });
    } catch (err: any) {
      jsonResponse(res, 500, { error: err.message });
    }
  });

  // ── Admin: All Users ──
  app.get("/api/admin/users", async (res, req) => {
    const authHeader = req.getHeader("authorization");
    res.onAborted(() => {});

    try {
      const auth = await authenticateRequest(authHeader);
      if (!auth || auth.user.role !== "ADMIN") {
        jsonResponse(res, 403, { error: "Admin access required" });
        return;
      }

      const allUsers = await dbQueries.getAllUsers();
      jsonResponse(res, 200, {
        users: allUsers.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          isVerified: u.isVerified,
          linkedNodeId: u.linkedNodeId,
          createdAt: u.createdAt,
        })),
      });
    } catch (err: any) {
      jsonResponse(res, 500, { error: err.message });
    }
  });

  // ── Admin: All Nodes ──
  app.get("/api/admin/nodes", async (res, req) => {
    const authHeader = req.getHeader("authorization");
    res.onAborted(() => {});

    try {
      const auth = await authenticateRequest(authHeader);
      if (!auth || auth.user.role !== "ADMIN") {
        jsonResponse(res, 403, { error: "Admin access required" });
        return;
      }

      const allNodes = await dbQueries.getAllNodes();
      jsonResponse(res, 200, { nodes: allNodes });
    } catch (err: any) {
      jsonResponse(res, 500, { error: err.message });
    }
  });

  console.log("[Auth] Authentication endpoints registered");
}

// ──────────────────────────────────────────────
// Helpers (shared with rest.ts)
// ──────────────────────────────────────────────

function jsonResponse(res: HttpResponse, status: number, data: any): void {
  const statusTexts: Record<number, string> = {
    200: "200 OK",
    201: "201 Created",
    400: "400 Bad Request",
    401: "401 Unauthorized",
    403: "403 Forbidden",
    404: "404 Not Found",
    409: "409 Conflict",
    423: "423 Locked",
    429: "429 Too Many Requests",
    500: "500 Internal Server Error",
  };

  try {
    res.cork(() => {
      res
        .writeStatus(statusTexts[status] || `${status}`)
        .writeHeader("Content-Type", "application/json")
        .writeHeader("Access-Control-Allow-Origin", "*")
        .writeHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        .writeHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
        .end(JSON.stringify(data));
    });
  } catch {
    // Response may already be aborted
  }
}

function readJson(
  res: HttpResponse,
  req: HttpRequest,
  callback: (body: any) => void
): void {
  let buffer = Buffer.alloc(0);
  let aborted = false;

  // NOTE: Do NOT call res.onAborted here — the route handler already set it.
  // uWebSockets.js only allows one onAborted callback; calling it again replaces the previous.

  res.onData((chunk, isLast) => {
    if (aborted) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

    if (isLast) {
      try {
        const body = JSON.parse(buffer.toString());
        callback(body);
      } catch {
        jsonResponse(res, 400, { error: "Invalid JSON body" });
      }
    }
  });
}

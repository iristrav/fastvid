/**
 * Password reset procedures for tRPC auth router
 * Uses in-memory token store (no database changes required)
 */

import { z } from "zod";
import { publicProcedure } from "./_core/trpc";
import { getSessionCookieOptions } from "./_core/cookies";
import { APP_ERROR, appTrpcError } from "@shared/appErrors";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { getUserByEmail, updateUserPassword, getUserById } from "./db";
import { sendPasswordResetEmail } from "./_core/passwordResetEmail";
import { createResetToken, validateResetToken as validateToken, consumeResetToken } from "./_core/passwordResetStore";

function getSessionSecret() {
  const secret = process.env.JWT_SECRET ?? "fallback-secret-change-in-production";
  return new TextEncoder().encode(secret);
}

async function signSessionToken(userId: number): Promise<string> {
  const expiresAt = Math.floor((Date.now() + ONE_YEAR_MS) / 1000);
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expiresAt)
    .sign(getSessionSecret());
}

/**
 * Request password reset email
 */
export const forgotPassword = publicProcedure
  .input(z.object({ email: z.string().email() }))
  .mutation(async ({ input, ctx }) => {
    const user = await getUserByEmail(input.email.toLowerCase());
    if (!user) {
      // Don't reveal if email exists (security best practice)
      return { success: true, message: "If an account with this email exists, a reset link has been sent" };
    }

    // Generate reset token
    const resetToken = createResetToken(user.id, user.email || "");

    // Build reset link
    const resetLink = `${ctx.req.headers.origin}/reset-password?token=${resetToken}`;

    // Send email
    if (!user.email) {
      console.warn("[Auth] User has no email address");
      return { success: true, message: "If an account with this email exists, a reset link has been sent" };
    }

    const emailSent = await sendPasswordResetEmail(user.email, resetToken, resetLink);
    if (!emailSent) {
      console.warn("[Auth] Email failed to send for", user.email);
      // Still return success to avoid revealing email existence
    }

    return { success: true, message: "If an account with this email exists, a reset link has been sent" };
  });

/**
 * Validate reset token
 */
export const validateResetToken = publicProcedure
  .input(z.object({ token: z.string().min(1) }))
  .query(({ input }) => {
    const result = validateToken(input.token);

    if (!result) {
      throw appTrpcError("BAD_REQUEST", APP_ERROR.INVALID_RESET_LINK, "Invalid or expired reset link");
    }

    return { valid: true, email: result.email };
  });

/**
 * Reset password with valid token
 */
export const resetPassword = publicProcedure
  .input(z.object({
    token: z.string().min(1),
    newPassword: z.string().min(8).max(128),
  }))
  .mutation(async ({ input, ctx }) => {
    const result = validateToken(input.token);

    if (!result) {
      throw appTrpcError("BAD_REQUEST", APP_ERROR.INVALID_RESET_LINK, "Invalid or expired reset link");
    }

    // Get user
    const user = await getUserById(result.userId);
    if (!user) {
      throw appTrpcError("INTERNAL_SERVER_ERROR", APP_ERROR.USER_NOT_FOUND, "User not found");
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(input.newPassword, 12);

    // Update user password
    await updateUserPassword(result.userId, passwordHash);

    // Consume token so it can't be reused
    consumeResetToken(input.token);

    // Sign in user immediately
    const token = await signSessionToken(user.id);
    const cookieOptions = getSessionCookieOptions(ctx.req);
    ctx.res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: ONE_YEAR_MS });

    return { success: true, user };
  });

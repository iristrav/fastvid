/**
 * Password reset procedures for tRPC auth router
 * Separated for clarity and maintainability
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicProcedure } from "./_core/trpc";
import { getSessionCookieOptions } from "./_core/cookies";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import {
  getUserByEmail,
  createPasswordResetToken,
  getPasswordResetTokenByToken,
  markPasswordResetTokenAsUsed,
  updateUserPassword,
  getUserById,
} from "./db";
import { sendPasswordResetEmail } from "./_core/emailService";
import { randomBytes } from "crypto";

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
  .mutation(async ({ input }) => {
    const user = await getUserByEmail(input.email.toLowerCase());
    if (!user) {
      // Don't reveal if email exists (security best practice)
      return { success: true, message: "If an account with this email exists, a reset link has been sent" };
    }

    // Generate reset token (32 bytes = 64 hex chars)
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await createPasswordResetToken({
      userId: user.id,
      token,
      expiresAt,
    });

    // Build reset link
    const baseUrl = process.env.VITE_FRONTEND_FORGE_API_URL || "http://localhost:3000";
    const resetLink = `${baseUrl}/reset-password?token=${token}`;

    // Send email
    if (!user.email) {
      console.warn("[Auth] User has no email address");
      return { success: true, message: "If an account with this email exists, a reset link has been sent" };
    }
    const emailSent = await sendPasswordResetEmail(user.email, resetLink);
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
  .query(async ({ input }) => {
    const resetToken = await getPasswordResetTokenByToken(input.token);

    if (!resetToken) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired reset token" });
    }

    if (resetToken.usedAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This reset link has already been used" });
    }

    if (new Date() > resetToken.expiresAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This reset link has expired" });
    }

    return { valid: true, userId: resetToken.userId };
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
    const resetToken = await getPasswordResetTokenByToken(input.token);

    if (!resetToken) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid or expired reset token" });
    }

    if (resetToken.usedAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This reset link has already been used" });
    }

    if (new Date() > resetToken.expiresAt) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This reset link has expired" });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(input.newPassword, 12);

    // Update user password
    await updateUserPassword(resetToken.userId, passwordHash);

    // Mark token as used
    await markPasswordResetTokenAsUsed(resetToken.id);

    // Sign in user immediately
    const user = await getUserById(resetToken.userId);
    if (!user) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "User not found" });
    }

    const token = await signSessionToken(user.id);
    const cookieOptions = getSessionCookieOptions(ctx.req);
    ctx.res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: ONE_YEAR_MS });

    return { success: true, user };
  });

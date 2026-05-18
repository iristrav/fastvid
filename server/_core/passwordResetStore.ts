/**
 * In-memory password reset token store
 * Tokens expire after 1 hour
 * Note: Tokens are lost on server restart. For production, use database storage.
 */

interface ResetToken {
  userId: number;
  email: string;
  expiresAt: number;
  createdAt: number;
}

const tokens = new Map<string, ResetToken>();

export function generateResetToken(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function createResetToken(userId: number, email: string): string {
  const token = generateResetToken();
  const now = Date.now();
  const expiresAt = now + 60 * 60 * 1000; // 1 hour

  tokens.set(token, {
    userId,
    email,
    expiresAt,
    createdAt: now,
  });

  // Cleanup expired tokens periodically
  if (tokens.size % 10 === 0) {
    cleanupExpiredTokens();
  }

  return token;
}

export function validateResetToken(token: string): { userId: number; email: string } | null {
  const resetToken = tokens.get(token);

  if (!resetToken) {
    return null;
  }

  if (resetToken.expiresAt < Date.now()) {
    tokens.delete(token);
    return null;
  }

  return {
    userId: resetToken.userId,
    email: resetToken.email,
  };
}

export function consumeResetToken(token: string): void {
  tokens.delete(token);
}

function cleanupExpiredTokens(): void {
  const now = Date.now();
  const expiredTokens: string[] = [];
  tokens.forEach((data, token) => {
    if (data.expiresAt < now) {
      expiredTokens.push(token);
    }
  });
  expiredTokens.forEach(token => tokens.delete(token));
}

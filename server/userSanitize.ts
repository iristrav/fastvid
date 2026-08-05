import type { User } from "../drizzle/schema";

/**
 * Strips fields that must never leave the server (currently just the bcrypt
 * hash) before a user row is returned over the wire. `getUserByEmail`/
 * `getUserById`/`getAllUsers` select every column — callers that forward the
 * row to a client (auth.me, login, register, resetPassword, admin.listUsers,
 * admin.getUser) must pass it through this first. Internal callers that need
 * the hash (login's bcrypt.compare, etc.) keep using the raw row.
 */
export type PublicUser = Omit<User, "passwordHash">;

export function sanitizeUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

export function sanitizeUsers(users: User[]): PublicUser[] {
  return users.map(sanitizeUser);
}

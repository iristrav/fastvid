import { and, desc, eq, isNull } from "drizzle-orm";
import {
  nicheRequests,
  type InsertNicheRequest,
  type NicheRequest,
  type NicheRequestStatus,
  type NicheRequestType,
} from "../drizzle/schema";
import { getDb } from "./db";

export async function createNicheRequest(data: InsertNicheRequest): Promise<number | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.insert(nicheRequests).values(data);
  return (result as unknown as [{ insertId: number }])[0]?.insertId as number;
}

export async function getNicheRequestById(id: number): Promise<NicheRequest | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(nicheRequests).where(eq(nicheRequests.id, id)).limit(1);
  return rows[0];
}

export async function getLatestNicheRequest(
  userId: number,
  requestType: NicheRequestType
): Promise<NicheRequest | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(nicheRequests)
    .where(and(eq(nicheRequests.userId, userId), eq(nicheRequests.requestType, requestType)))
    .orderBy(desc(nicheRequests.createdAt))
    .limit(1);
  return rows[0];
}

export async function getLatestNicheRequestByEmail(
  contactEmail: string,
  requestType: NicheRequestType
): Promise<NicheRequest | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const email = contactEmail.toLowerCase().trim();
  const rows = await db
    .select()
    .from(nicheRequests)
    .where(and(eq(nicheRequests.contactEmail, email), eq(nicheRequests.requestType, requestType)))
    .orderBy(desc(nicheRequests.createdAt))
    .limit(1);
  return rows[0];
}

export async function getLatestOnboardingRequest(
  userId?: number | null,
  contactEmail?: string | null
): Promise<NicheRequest | undefined> {
  if (userId) {
    const byUser = await getLatestNicheRequest(userId, "onboarding");
    if (byUser) return byUser;
  }
  if (contactEmail) {
    return getLatestNicheRequestByEmail(contactEmail, "onboarding");
  }
  return undefined;
}

export async function linkNicheRequestsToUser(contactEmail: string, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const email = contactEmail.toLowerCase().trim();
  await db
    .update(nicheRequests)
    .set({ userId })
    .where(and(eq(nicheRequests.contactEmail, email), isNull(nicheRequests.userId)));
}

export async function listNicheRequestsByUser(userId: number): Promise<NicheRequest[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(nicheRequests)
    .where(eq(nicheRequests.userId, userId))
    .orderBy(desc(nicheRequests.createdAt));
}

export async function listAllNicheRequests(): Promise<NicheRequest[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(nicheRequests).orderBy(desc(nicheRequests.createdAt));
}

export async function updateNicheRequest(
  id: number,
  data: Partial<InsertNicheRequest> & { status?: NicheRequestStatus }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(nicheRequests).set(data).where(eq(nicheRequests.id, id));
}

export function nicheRequestAllowsPlatformAccess(
  request: NicheRequest | undefined,
  role: string
): boolean {
  if (role === "admin") return true;
  if (!request) return true;
  return ["approved", "in_progress", "ready"].includes(request.status);
}

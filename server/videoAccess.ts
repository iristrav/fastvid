/**
 * RONDE 148 §21 — who may touch a video, in one place.
 *
 * This function lived inside `routers.ts` as a private helper. The editor's routes need exactly
 * the same rule, and there were only two ways to give it to them: import it from routers.ts, which
 * is a cycle because routers.ts mounts the editor's router, or write a second copy.
 *
 * A second copy is the worse option and not by a little. Two ownership checks drift, one of them
 * ends up looser, and the looser one is the one an attacker finds. So the single definition moved
 * here and `routers.ts` imports it — the behaviour is unchanged, byte for byte, including which
 * error code each refusal carries.
 *
 * The rule itself: you may act on a video you own, and an admin may act on any. Nothing else.
 */
import { APP_ERROR, appTrpcError } from "@shared/appErrors";
import type { TrpcContext } from "./_core/context";
import type { Video } from "../drizzle/schema";

export function requireVideoAccess(
  video: Video | null | undefined,
  ctx: TrpcContext & { user: NonNullable<TrpcContext["user"]> }
): Video {
  if (!video) throw appTrpcError("NOT_FOUND", APP_ERROR.NOT_FOUND, "Resource not found");
  if (video.userId !== ctx.user.id && ctx.user.role !== "admin") {
    throw appTrpcError("FORBIDDEN", APP_ERROR.FORBIDDEN_RESOURCE, "You do not have access to this resource");
  }
  return video;
}

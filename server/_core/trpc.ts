import { APP_ERROR, appTrpcError } from "@shared/appErrors";
import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw appTrpcError("UNAUTHORIZED", APP_ERROR.UNAUTHED, "Please login");
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw appTrpcError("FORBIDDEN", APP_ERROR.NOT_ADMIN, "You do not have required permission");
  }
  return next({ ctx });
});

export const subscribedProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role === "admin") return next({ ctx });
  if (ctx.user.subscriptionStatus !== "active") {
    throw appTrpcError("FORBIDDEN", APP_ERROR.SUBSCRIPTION_REQUIRED, "Active subscription required");
  }
  return next({ ctx });
});

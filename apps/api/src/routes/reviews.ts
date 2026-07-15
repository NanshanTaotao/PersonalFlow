import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ReviewReport, SessionView } from "@personalflow/contracts";
import { generateReviewReport } from "@personalflow/review";

import { replayOrRun, type ProductApiContext } from "../context";
import { conflictError, scenarioError } from "../errors";
import { productSessionDto } from "../session-dto";
import { startSessionWithRootBranch } from "../session-forks";

export const reviewDto = (review: ReviewReport & { readonly review_adapter_kind?: string }): ReviewReport & { readonly review_adapter_kind?: string } => ({
  ...review
});

export const saveGeneratedReview = async (context: ProductApiContext, report: ReviewReport, reviewAdapterKind: string): Promise<ReviewReport & { readonly review_adapter_kind?: string }> => {
  if (report.status === "succeeded") {
    return context.repositories.reviewReports.saveSucceeded(report.id, {
      summary: report.summary,
      dimensions: report.dimensions,
      key_moments: report.key_moments,
      recommendations: report.recommendations,
      evidence_refs: report.evidence_refs,
      ...(report.evidence_summary === undefined ? {} : { evidence_summary: report.evidence_summary }),
      ...(report.credibility_checks === undefined ? {} : { credibility_checks: report.credibility_checks }),
      uncertainty_notes: report.uncertainty_notes,
      completed_at: report.completed_at,
      review_adapter_kind: reviewAdapterKind
    });
  }
  if (report.status === "failed") {
    return context.repositories.reviewReports.saveFailed(report.id, {
      error_message: report.error_message,
      completed_at: report.completed_at,
      review_adapter_kind: reviewAdapterKind
    });
  }
  return report;
};

export const isEndedForReview = (
  view: SessionView,
  _events: Awaited<ReturnType<ProductApiContext["runtime"]["listEvents"]>>
): boolean => {
  return view.status === "completed" || view.status === "ended";
};

const isFailureReviewable = (view: SessionView): boolean =>
  view.failure_summary !== undefined;

const saveFailureSummaryReview = async (
  context: ProductApiContext,
  reviewId: string,
  sessionId: string,
  view: SessionView
): Promise<ReviewReport & { readonly review_adapter_kind?: string }> => {
  const summary = view.failure_summary;
  if (summary === undefined) {
    throw conflictError("Review requires an ended session.");
  }
  const saved = await context.repositories.reviewReports.saveFailed(reviewId, {
    error_message: `AI 回合失败：${summary.message} 失败发生在当前 AI 回合，建议${summary.action_label}或到模型配置页检查连接。`,
    completed_at: context.now(),
    review_adapter_kind: "failure-summary"
  });
  return reviewDto(saved);
};

export const generateAndSaveReview = async (
  context: ProductApiContext,
  reviewId: string,
  sessionId: string,
  input?: {
    readonly view: SessionView;
    readonly events: Awaited<ReturnType<ProductApiContext["runtime"]["listEvents"]>>;
  }
): Promise<ReviewReport> => {
  const view = input?.view ?? await context.runtime.getView(sessionId);
  const events = input?.events ?? await context.runtime.listEvents(sessionId);
  if (isFailureReviewable(view)) {
    return saveFailureSummaryReview(context, reviewId, sessionId, view);
  }
  if (!isEndedForReview(view, events)) {
    throw conflictError("Review requires an ended session.");
  }
  const scenario = await context.runtime.getScenario(sessionId);
  const reviewAdapterRoute = await context.createReviewAdapter();
  const report = await generateReviewReport({
    review_id: reviewId,
    session_id: sessionId,
    scenario,
    events,
    adapter: reviewAdapterRoute.adapter,
    now: context.now
  });
  const saved = await saveGeneratedReview(context, report, reviewAdapterRoute.kind);
  return reviewDto(saved);
};

const idempotentOnlyBody = z.object({ idempotency_key: z.string().min(1).optional() }).strict();

const parseParams = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => schema.parse(value);

export const registerReviewRoutes = (app: FastifyInstance, context: ProductApiContext): void => {
  app.post("/api/sessions/:sessionId/reviews", async (request, reply) => {
    const { sessionId } = parseParams(z.object({ sessionId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(idempotentOnlyBody, request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { sessionId, body }, async () => {
      const view = await context.runtime.getView(sessionId);
      const events = await context.runtime.listEvents(sessionId);
      if (!isEndedForReview(view, events) && !isFailureReviewable(view)) {
        throw conflictError("Review requires an ended session.");
      }
      const pending = await context.repositories.reviewReports.createPending({
        id: context.createId("review"),
        session_id: sessionId,
        created_at: context.now()
      });
      const review = await generateAndSaveReview(context, pending.id, sessionId, { view, events });
      return { statusCode: review.status === "succeeded" ? 201 : 202, body: { review: reviewDto(review) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.get("/api/reviews/:reviewId", async (request) => {
    const { reviewId } = parseParams(z.object({ reviewId: z.string().min(1) }).strict(), request.params);
    const review = await context.repositories.reviewReports.get(reviewId);
    if (review === null) {
      throw scenarioError("Review does not exist.", 404);
    }
    return { review: reviewDto(review) };
  });

  app.post("/api/reviews/:reviewId/retry", async (request, reply) => {
    const { reviewId } = parseParams(z.object({ reviewId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(idempotentOnlyBody, request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { reviewId, body }, async () => {
      const existing = await context.repositories.reviewReports.get(reviewId);
      if (existing === null) {
        throw scenarioError("Review does not exist.", 404);
      }
      if (existing.status === "succeeded") {
        throw conflictError("Succeeded review cannot be retried.");
      }
      const review = await generateAndSaveReview(context, existing.id, existing.session_id);
      return { statusCode: review.status === "succeeded" ? 200 : 202, body: { review: reviewDto(review) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.post("/api/reviews/:reviewId/repractice", async (request, reply) => {
    const { reviewId } = parseParams(z.object({ reviewId: z.string().min(1) }).strict(), request.params);
    const body = parseParams(idempotentOnlyBody, request.body ?? {});
    const result = await replayOrRun(context, body.idempotency_key, { reviewId, body, method: "repractice" }, async () => {
      const existing = await context.repositories.reviewReports.get(reviewId);
      if (existing === null) {
        throw scenarioError("找不到这次复盘，请返回最近复盘重新打开。", 404);
      }
      const scenario = await context.runtime.getScenario(existing.session_id);
      const view = await startSessionWithRootBranch(context, scenario);
      return { statusCode: 201, body: { session: await productSessionDto(context, view) } };
    });
    return reply.code(result.statusCode).send(result.body);
  });
};

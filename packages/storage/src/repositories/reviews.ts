import type {
  ReviewDimension,
  ReviewCredibilityCheck,
  ReviewEvidenceRef,
  ReviewEvidenceSummary,
  ReviewKeyMoment,
  ReviewRecommendation,
  ReviewReport
} from "@personalflow/contracts";
import {
  ReviewCredibilityCheckSchema,
  ReviewDimensionSchema,
  ReviewEvidenceRefSchema,
  ReviewEvidenceSummarySchema,
  ReviewKeyMomentSchema,
  ReviewRecommendationSchema,
  ReviewReportSchema,
  ReviewReportStatusSchema
} from "@personalflow/contracts";

import type { StorageDatabase } from "../db";
import { StorageError, toStorageError } from "../errors";
import { parseJson, stringifyJson } from "../json";

export interface CreatePendingReviewReportInput {
  readonly id: string;
  readonly session_id: string;
  readonly created_at: string;
}

export interface SaveSucceededReviewReportInput {
  readonly summary: string;
  readonly dimensions: readonly ReviewDimension[];
  readonly key_moments: readonly ReviewKeyMoment[];
  readonly recommendations: readonly ReviewRecommendation[];
  readonly evidence_refs: readonly ReviewEvidenceRef[];
  readonly evidence_summary?: ReviewEvidenceSummary;
  readonly credibility_checks?: readonly ReviewCredibilityCheck[];
  readonly uncertainty_notes: readonly string[];
  readonly completed_at: string;
  readonly review_adapter_kind?: string;
}

export interface SaveFailedReviewReportInput {
  readonly error_message: string;
  readonly completed_at: string;
  readonly review_adapter_kind?: string;
}

export type StoredReviewReport = ReviewReport & { readonly review_adapter_kind?: string };

export interface RecentReviewReportSummary {
  readonly id: string;
  readonly title: string;
  readonly status: ReviewReport["status"];
  readonly session_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ReviewReportRow {
  readonly id: string;
  readonly session_id: string;
  readonly status: string;
  readonly summary: string | null;
  readonly dimensions_json: string | null;
  readonly key_moments_json: string | null;
  readonly recommendations_json: string | null;
  readonly evidence_refs_json: string | null;
  readonly evidence_summary_json: string | null;
  readonly credibility_checks_json: string | null;
  readonly uncertainty_notes_json: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly error_message: string | null;
  readonly review_adapter_kind: string | null;
}

const parseArray = <T>(json: string | null, schema: { parse(value: unknown): T }): T[] => {
  if (json === null) {
    return [];
  }
  return parseJson(json, { parse: (value) => (Array.isArray(value) ? value.map((item) => schema.parse(item)) : []) });
};

const attachReviewAdapterKind = (report: ReviewReport, reviewAdapterKind: string | null): StoredReviewReport =>
  reviewAdapterKind === null ? report : { ...report, review_adapter_kind: reviewAdapterKind };

const rowToReport = (row: ReviewReportRow): StoredReviewReport => {
  const base = {
    id: row.id,
    session_id: row.session_id,
    status: row.status,
    created_at: row.created_at
  };
  if (row.status === "pending") {
    return attachReviewAdapterKind(ReviewReportSchema.parse(base), row.review_adapter_kind);
  }
  if (row.status === "failed") {
    return attachReviewAdapterKind(ReviewReportSchema.parse({
      ...base,
      completed_at: row.completed_at,
      error_message: row.error_message
    }), row.review_adapter_kind);
  }
  return attachReviewAdapterKind(ReviewReportSchema.parse({
    ...base,
    summary: row.summary,
    dimensions: parseArray(row.dimensions_json, ReviewDimensionSchema),
    key_moments: parseArray(row.key_moments_json, ReviewKeyMomentSchema),
    recommendations: parseArray(row.recommendations_json, ReviewRecommendationSchema),
    evidence_refs: parseArray(row.evidence_refs_json, ReviewEvidenceRefSchema),
    ...(row.evidence_summary_json === null ? {} : { evidence_summary: parseJson(row.evidence_summary_json, ReviewEvidenceSummarySchema) }),
    ...(row.credibility_checks_json === null ? {} : { credibility_checks: parseArray(row.credibility_checks_json, ReviewCredibilityCheckSchema) }),
    uncertainty_notes: parseJson(row.uncertainty_notes_json ?? "[]", { parse: (value) => (Array.isArray(value) ? value : []) as string[] }),
    completed_at: row.completed_at
  }), row.review_adapter_kind);
};

const clampRecentLimit = (limit = 10): number =>
  Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;

const reviewTitle = (row: ReviewReportRow): string => {
  if (row.status === "succeeded") {
    return row.summary?.trim() !== "" && row.summary !== null ? row.summary : "复盘摘要";
  }
  if (row.status === "failed") {
    return "复盘生成失败";
  }
  return "复盘待生成";
};

const rowToRecentSummary = (row: ReviewReportRow): RecentReviewReportSummary => ({
  id: row.id,
  title: reviewTitle(row),
  status: ReviewReportStatusSchema.parse(row.status),
  session_id: row.session_id,
  created_at: row.created_at,
  updated_at: row.completed_at ?? row.created_at
});

export class ReviewReportsRepository {
  constructor(private readonly database: StorageDatabase) {}

  async createPending(input: CreatePendingReviewReportInput): Promise<StoredReviewReport> {
    try {
      this.database.sqlite
        .prepare(
          `insert into review_reports (
            id, session_id, status, summary, dimensions_json, key_moments_json, recommendations_json,
            evidence_refs_json, evidence_summary_json, credibility_checks_json, uncertainty_notes_json,
            created_at, completed_at, error_message
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(input.id, input.session_id, "pending", null, null, null, null, null, null, null, null, input.created_at, null, null);
      const report = await this.get(input.id);
      if (report === null) {
        throw new Error("Created review report cannot be read.");
      }
      return report;
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async saveSucceeded(id: string, input: SaveSucceededReviewReportInput): Promise<ReviewReport> {
    try {
      const result = this.database.sqlite
        .prepare(
          `update review_reports
           set status = ?, summary = ?, dimensions_json = ?, key_moments_json = ?, recommendations_json = ?,
               evidence_refs_json = ?, evidence_summary_json = ?, credibility_checks_json = ?,
               uncertainty_notes_json = ?, completed_at = ?, error_message = ?, review_adapter_kind = ?
           where id = ?`
        )
        .run(
          "succeeded",
          input.summary,
          stringifyJson(input.dimensions.map((item) => ReviewDimensionSchema.parse(item))),
          stringifyJson(input.key_moments.map((item) => ReviewKeyMomentSchema.parse(item))),
          stringifyJson(input.recommendations.map((item) => ReviewRecommendationSchema.parse(item))),
          stringifyJson(input.evidence_refs.map((item) => ReviewEvidenceRefSchema.parse(item))),
          input.evidence_summary === undefined ? null : stringifyJson(ReviewEvidenceSummarySchema.parse(input.evidence_summary)),
          input.credibility_checks === undefined ? null : stringifyJson(input.credibility_checks.map((item) => ReviewCredibilityCheckSchema.parse(item))),
          stringifyJson([...input.uncertainty_notes]),
          input.completed_at,
          null,
          input.review_adapter_kind ?? null,
          id
        );
      if (result.changes !== 1) {
        throw new StorageError("storage_not_found", "Review report does not exist.");
      }
      const report = await this.get(id);
      if (report === null) {
        throw new Error("Succeeded review report cannot be read.");
      }
      return report;
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async saveFailed(id: string, input: SaveFailedReviewReportInput): Promise<ReviewReport> {
    try {
      const result = this.database.sqlite
        .prepare(
          `update review_reports
           set status = ?, summary = ?, dimensions_json = ?, key_moments_json = ?, recommendations_json = ?,
               evidence_refs_json = ?, evidence_summary_json = ?, credibility_checks_json = ?,
               uncertainty_notes_json = ?, completed_at = ?, error_message = ?, review_adapter_kind = ?
           where id = ?`
        )
        .run("failed", null, null, null, null, null, null, null, null, input.completed_at, input.error_message, input.review_adapter_kind ?? null, id);
      if (result.changes !== 1) {
        throw new StorageError("storage_not_found", "Review report does not exist.");
      }
      const report = await this.get(id);
      if (report === null) {
        throw new Error("Failed review report cannot be read.");
      }
      return report;
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async get(id: string): Promise<StoredReviewReport | null> {
    try {
      const row = this.database.sqlite.prepare("select * from review_reports where id = ?").get(id) as
        | ReviewReportRow
        | undefined;
      return row === undefined ? null : rowToReport(row);
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async listRecent(limit = 10): Promise<RecentReviewReportSummary[]> {
    try {
      const rows = this.database.sqlite
        .prepare("select * from review_reports order by coalesce(completed_at, created_at) desc, created_at desc, id desc limit ?")
        .all(clampRecentLimit(limit)) as ReviewReportRow[];
      return rows.map(rowToRecentSummary);
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async listBySession(sessionId: string): Promise<RecentReviewReportSummary[]> {
    try {
      const rows = this.database.sqlite
        .prepare("select * from review_reports where session_id = ? order by coalesce(completed_at, created_at) desc, created_at desc, id desc")
        .all(sessionId) as ReviewReportRow[];
      return rows.map(rowToRecentSummary);
    } catch (error) {
      throw toStorageError(error);
    }
  }
}

export const createReviewReportsRepository = (database: StorageDatabase): ReviewReportsRepository =>
  new ReviewReportsRepository(database);

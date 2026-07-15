import { z } from "zod";

import type {
  NormalizedScenarioV1,
  ReviewCredibilityCheck,
  ReviewDimension,
  ReviewEvidenceRef,
  ReviewEvidenceSummary,
  ReviewKeyMoment,
  ReviewRecommendation,
  ReviewReport,
  RuntimeEvent
} from "@personalflow/contracts";
import {
  ReviewDimensionSchema,
  ReviewEvidenceRefSchema,
  ReviewKeyMomentSchema,
  ReviewRecommendationSchema,
  ReviewReportSchema
} from "@personalflow/contracts";

import { extractReviewEvidence, type ReviewEvidenceItem } from "./evidence";
import { renderReviewPrompt } from "./prompt";

export interface ReviewModelResponse {
  readonly content: string;
}

export interface ReviewModelAdapter {
  complete(input: { readonly prompt: string }): Promise<ReviewModelResponse>;
}

export interface GenerateReviewReportInput {
  readonly review_id: string;
  readonly session_id: string;
  readonly scenario: NormalizedScenarioV1;
  readonly events: readonly RuntimeEvent[];
  readonly adapter: ReviewModelAdapter;
  readonly now: () => string;
}

const GeneratedReviewSchema = z
  .object({
    summary: z.string().min(1),
    dimensions: z.array(ReviewDimensionSchema).min(1),
    key_moments: z.array(ReviewKeyMomentSchema).min(1),
    recommendations: z.array(ReviewRecommendationSchema).min(1),
    evidence_refs: z.array(ReviewEvidenceRefSchema).min(1),
    uncertainty_notes: z.array(z.string().min(1)).min(1)
  })
  .strict();

type GeneratedReview = z.infer<typeof GeneratedReviewSchema>;

type ParseGeneratedReviewResult =
  | { readonly ok: true; readonly review: GeneratedReview }
  | { readonly ok: false; readonly error_message: "json_parse_failed" | "review_schema_invalid" };

type ReviewGenerationError =
  | "json_parse_failed"
  | "review_schema_invalid"
  | "review_evidence_ref_invalid"
  | "review_rubric_dimension_invalid"
  | "review_model_empty"
  | "review_model_failed";

const failedReport = (input: GenerateReviewReportInput, error_message: string): ReviewReport => {
  const now = input.now();
  return ReviewReportSchema.parse({
    id: input.review_id,
    session_id: input.session_id,
    status: "failed",
    created_at: now,
    completed_at: now,
    error_message
  });
};

const refKey = (ref: ReviewEvidenceRef): string =>
  [ref.session_id, ref.event_id, ref.sequence, ref.step_id, ref.actor_id].join("|");

const evidenceRefSet = (evidence: readonly ReviewEvidenceItem[]): Set<string> => new Set(evidence.map((item) => refKey(item.ref)));

interface ReviewRefContainer {
  readonly evidence_refs: readonly ReviewEvidenceRef[];
  readonly dimensions: readonly { readonly evidence_refs: readonly ReviewEvidenceRef[] }[];
  readonly key_moments: readonly { readonly evidence_ref: ReviewEvidenceRef }[];
  readonly recommendations: readonly { readonly evidence_refs?: readonly ReviewEvidenceRef[] | undefined }[];
}

const uniqueRefs = (refs: readonly ReviewEvidenceRef[]): ReviewEvidenceRef[] => {
  const deduped = new Map<string, ReviewEvidenceRef>();
  for (const ref of refs) {
    deduped.set(refKey(ref), ref);
  }
  return [...deduped.values()];
};

const collectRefs = (generated: ReviewRefContainer): ReviewEvidenceRef[] => [
  ...generated.evidence_refs,
  ...generated.dimensions.flatMap((dimension) => dimension.evidence_refs),
  ...generated.key_moments.map((moment) => moment.evidence_ref),
  ...generated.recommendations.flatMap((recommendation) => recommendation.evidence_refs ?? [])
];

const hasDuplicateRefs = (refs: readonly ReviewEvidenceRef[]): boolean => {
  const seen = new Set<string>();
  for (const item of refs) {
    const key = refKey(item);
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
  }
  return false;
};

const normalizeJsonObjectContent = (content: string): string => {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeRefsAlias = (value: Record<string, unknown>): Record<string, unknown> => {
  const normalized = { ...value };
  if (normalized.evidence_refs === undefined && normalized.refs !== undefined) {
    normalized.evidence_refs = normalized.refs;
  }
  delete normalized.refs;
  return normalized;
};

const normalizeDimension = (value: unknown): unknown => {
  if (!isRecord(value)) {
    return value;
  }
  const normalized = normalizeRefsAlias(value);
  if (normalized.conclusion === undefined && typeof normalized.evaluation === "string") {
    normalized.conclusion = normalized.evaluation;
  }
  delete normalized.evaluation;
  return normalized;
};

const normalizeKeyMoment = (value: unknown): unknown => {
  if (!isRecord(value)) {
    return value;
  }
  const normalized = { ...value };
  if (normalized.description === undefined && typeof normalized.impact === "string") {
    normalized.description = normalized.impact;
  }
  if (normalized.evidence_ref === undefined && Array.isArray(normalized.refs)) {
    normalized.evidence_ref = normalized.refs[0];
  }
  delete normalized.impact;
  delete normalized.refs;
  return normalized;
};

const normalizeRecommendation = (value: unknown): unknown => {
  if (!isRecord(value)) {
    return value;
  }
  return normalizeRefsAlias(value);
};

const normalizeGeneratedReviewShape = (value: unknown): unknown => {
  if (!isRecord(value)) {
    return value;
  }

  const normalized = normalizeRefsAlias(value);
  if (Array.isArray(normalized.dimensions)) {
    normalized.dimensions = normalized.dimensions.map(normalizeDimension);
  }
  if (Array.isArray(normalized.key_moments)) {
    normalized.key_moments = normalized.key_moments.map(normalizeKeyMoment);
  }
  if (Array.isArray(normalized.recommendations)) {
    normalized.recommendations = normalized.recommendations.map(normalizeRecommendation);
  }
  if (typeof normalized.uncertainty_notes === "string") {
    normalized.uncertainty_notes = [normalized.uncertainty_notes];
  }
  return normalized;
};

const parseGeneratedReview = (content: string): ParseGeneratedReviewResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizeJsonObjectContent(content));
  } catch {
    return { ok: false, error_message: "json_parse_failed" };
  }

  const generated = GeneratedReviewSchema.safeParse(normalizeGeneratedReviewShape(parsed));
  if (!generated.success) {
    return { ok: false, error_message: "review_schema_invalid" };
  }
  return { ok: true, review: generated.data };
};

const refsAreValid = (generated: GeneratedReview, evidence: readonly ReviewEvidenceItem[]): boolean => {
  if (hasDuplicateRefs(generated.evidence_refs)) {
    return false;
  }
  const allowed = evidenceRefSet(evidence);
  return collectRefs(generated).every((ref) => allowed.has(refKey(ref)));
};

const rubricDimensionTitleByAcceptedName = (scenario: NormalizedScenarioV1): Map<string, string> => {
  const accepted = new Map<string, string>();
  for (const dimension of scenario.review_rubric.dimensions) {
    accepted.set(dimension.id, dimension.title);
    accepted.set(dimension.title, dimension.title);
  }
  return accepted;
};

type ApplyRubricResult =
  | { readonly ok: true; readonly review: GeneratedReview }
  | { readonly ok: false; readonly error_message: "review_rubric_dimension_invalid" };

const requiredDimensionUncertaintyNotes = (
  scenario: NormalizedScenarioV1,
  evidence: readonly ReviewEvidenceItem[]
): string[] => {
  const observedTags = new Set(evidence.flatMap((item) => item.review_tags));
  return scenario.review_rubric.dimensions
    .filter((dimension) => dimension.evidence_requirement === "required")
    .filter((dimension) => !dimension.evidence_tags.some((tag) => observedTags.has(tag)))
    .map((dimension) => `证据不足：${dimension.title} 缺少可观察证据。`);
};

const evidenceMatchingTags = (
  evidence: readonly ReviewEvidenceItem[],
  tags: readonly string[]
): ReviewEvidenceItem[] => {
  const acceptedTags = new Set(tags);
  return evidence.filter((item) => item.review_tags.some((tag) => acceptedTags.has(tag)));
};

const missingEvidenceConclusion = (title: string): string =>
  `证据不足：${title} 缺少可观察证据，无法给出可靠判断。`;

const missingGeneratedConclusion = (title: string): string =>
  `证据有限：${title} 有可观察证据，但模型未返回该维度的独立结论，需结合引用片段核对。`;

const mismatchedEvidenceConclusion = (title: string): string =>
  `证据有限：${title} 有可观察证据，但原始复盘未提供匹配引用，需结合引用片段核对。`;

const invalidGeneratedConclusion = (title: string): string =>
  `证据有限：${title} 有可观察证据，但模型未返回有效维度结论，需结合引用片段核对。`;

const informativeTextPattern = /[\p{L}\p{N}]/u;

const isInformativeConclusion = (text: string): boolean =>
  informativeTextPattern.test(text.trim());

const applyScenarioRubric = (
  generated: GeneratedReview,
  scenario: NormalizedScenarioV1,
  evidence: readonly ReviewEvidenceItem[]
): ApplyRubricResult => {
  const accepted = rubricDimensionTitleByAcceptedName(scenario);
  const generatedDimensions = new Map<string, ReviewDimension>();
  for (const dimension of generated.dimensions) {
    const title = accepted.get(dimension.name);
    if (title === undefined) {
      return { ok: false, error_message: "review_rubric_dimension_invalid" };
    }
    if (!generatedDimensions.has(title)) {
      generatedDimensions.set(title, { ...dimension, name: title });
    }
  }

  const dimensions = scenario.review_rubric.dimensions.map((dimension): ReviewDimension => {
    const generatedDimension = generatedDimensions.get(dimension.title);
    const matchingEvidence = evidenceMatchingTags(evidence, dimension.evidence_tags);
    const matchingEvidenceRefKeys = new Set(matchingEvidence.map((item) => refKey(item.ref)));
    const generatedMatchingRefs = uniqueRefs(
      generatedDimension?.evidence_refs.filter((ref) => matchingEvidenceRefKeys.has(refKey(ref))) ?? []
    );
    const generatedMatchingRefKeys = new Set(generatedMatchingRefs.map(refKey));
    const uncitedUserMatchingRefs = matchingEvidence
      .filter((item) => item.actor_kind === "user")
      .map((item) => item.ref)
      .filter((ref) => !generatedMatchingRefKeys.has(refKey(ref)));
    const evidenceRefs = generatedMatchingRefs.length > 0
      ? uniqueRefs([...generatedMatchingRefs, ...uncitedUserMatchingRefs])
      : uniqueRefs(matchingEvidence.map((item) => item.ref));
    const conclusion = evidenceRefs.length === 0
      ? missingEvidenceConclusion(dimension.title)
      : generatedDimension === undefined
        ? missingGeneratedConclusion(dimension.title)
        : generatedMatchingRefs.length === 0
          ? mismatchedEvidenceConclusion(dimension.title)
          : isInformativeConclusion(generatedDimension.conclusion)
            ? generatedDimension.conclusion
            : invalidGeneratedConclusion(dimension.title);
    return {
      name: dimension.title,
      conclusion,
      evidence_refs: evidenceRefs
    };
  });

  const uncertaintyNotes = [
    ...generated.uncertainty_notes,
    ...requiredDimensionUncertaintyNotes(scenario, evidence)
  ];
  return {
    ok: true,
    review: {
      ...generated,
      dimensions,
      uncertainty_notes: Array.from(new Set(uncertaintyNotes))
    }
  };
};

const firstReadableEvidenceText = (item: ReviewEvidenceItem): string | null => {
  for (const summary of item.args_summary) {
    const separator = summary.indexOf("=");
    const value = separator >= 0 ? summary.slice(separator + 1).trim() : summary.trim();
    if (value.length > 0 && value !== "[redacted]") {
      return value;
    }
  }
  return null;
};

const safeSnippet = (text: string | null): string => {
  if (text === null || text.trim().length === 0) {
    return "片段内容未记录。";
  }
  const trimmed = text.trim();
  return trimmed.length > 160 ? trimmed.slice(0, 157) + "..." : trimmed;
};

const evidenceLocator = (item: ReviewEvidenceItem) => ({
  sequence: item.ref.sequence,
  speaker: item.actor_display_name,
  snippet: safeSnippet(firstReadableEvidenceText(item))
});

const keyMomentTitle = (actorName: string, text: string | null): string => {
  if (text?.includes("证据链")) {
    return `${actorName}回应了证据链`;
  }
  if (text?.includes("指标")) {
    return `${actorName}补充了指标信息`;
  }
  return `${actorName}提供了关键回答`;
};

const keyMomentDescription = (actorName: string, text: string | null): string => {
  if (text === null) {
    return `${actorName}提交了一段可用于复盘的回答，支撑了本次复盘判断。`;
  }
  return `${actorName}提到“${text}”，支撑了本次复盘判断。`;
};

const buildReadableKeyMoments = (
  generated: GeneratedReview,
  evidence: readonly ReviewEvidenceItem[]
): ReviewKeyMoment[] => {
  const evidenceByRef = new Map(evidence.map((item) => [refKey(item.ref), item]));
  const generatedEvidence = generated.key_moments.flatMap((moment) => {
    const item = evidenceByRef.get(refKey(moment.evidence_ref));
    return item === undefined ? [] : [item];
  });
  const userEvidence = evidence.filter((item) => item.actor_kind === "user");
  const sourceEvidence = userEvidence.length > 0 ? userEvidence : generatedEvidence;
  const readableEvidence = sourceEvidence.length > 0 ? sourceEvidence : generatedEvidence;
  const seen = new Set<string>();

  return readableEvidence.flatMap((item) => {
    const key = refKey(item.ref);
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    const text = firstReadableEvidenceText(item);
    return [{
      title: keyMomentTitle(item.actor_display_name, text),
      description: keyMomentDescription(item.actor_display_name, text),
      evidence_ref: item.ref,
      evidence_locator: evidenceLocator(item)
    }];
  });
};

const buildEvidenceSummary = (generated: ReviewRefContainer, evidence: readonly ReviewEvidenceItem[]): ReviewEvidenceSummary => {
  const userEvidence = evidence.filter((item) => item.actor_kind === "user");
  const userEvidenceKeys = new Set(userEvidence.map((item) => refKey(item.ref)));
  const citedUserKeys = new Set(collectRefs(generated).map(refKey).filter((key) => userEvidenceKeys.has(key)));
  const answerCount = userEvidence.length;
  const citedAnswerCount = citedUserKeys.size;
  const sufficient = answerCount > 0 && citedAnswerCount === answerCount;
  return {
    answer_count: answerCount,
    cited_answer_count: citedAnswerCount,
    coverage: sufficient ? "sufficient" : "insufficient",
    confidence: sufficient ? confidenceCapByAnswerCount(answerCount) : "low"
  };
};

const confidenceCapByAnswerCount = (answerCount: number): "high" | "medium" | "low" => {
  if (answerCount <= 3) {
    return "low";
  }
  if (answerCount <= 7) {
    return "medium";
  }
  return "high";
};

const downgradeConfidenceForWarnings = (
  evidenceSummary: ReviewEvidenceSummary,
  credibilityChecks: readonly ReviewCredibilityCheck[]
): ReviewEvidenceSummary => {
  const hasWarning = credibilityChecks.some((check) => check.severity === "warning");
  if (!hasWarning || evidenceSummary.confidence !== "high") {
    return evidenceSummary;
  }
  return {
    ...evidenceSummary,
    confidence: "medium"
  };
};

const shortSampleUncertaintyNote = (answerCount: number): string | null =>
  answerCount > 0 && answerCount <= 3
    ? `本次复盘仅基于 ${answerCount} 条用户回答，适合观察本轮演练中的表达和证据倾向，不能代表稳定能力判断。`
    : null;

const shortSampleLanguagePattern = /短样本|样本(?:量)?较(?:小|短)|低可信|不宜推断长期能力|不能代表稳定能力判断|limited sample|short sample|low confidence/i;
const shortSampleAnswerCountPattern = /(?:仅有|仅基于|只有|只基于)\s*\d+\s*条(?:用户)?回答/;
const generatedEventCountPattern = /\d+\s*轮事件/g;

const answerCountPatterns = [
  /(\d+)\s*条(?:用户)?回答/g,
  /(?:用户)?回答(?:数量|数)?(?:为|是|共|共有|总计|合计)\s*(\d+)\s*条/g,
  /(?:基于|引用|来自|包含|共有|当前|本次演练(?:的)?|本轮(?:的)?)\s*(\d+)\s*条(?:用户)?回答/g
] as const;

const generatedTextFallback = (evidenceSummary: ReviewEvidenceSummary): string =>
  `本次复盘引用 ${evidenceSummary.answer_count} 条用户回答，结论以本轮可观察证据为准。`;

const hasConflictingAnswerCount = (text: string, answerCount: number): boolean => {
  for (const pattern of answerCountPatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (Number(match[1]) !== answerCount) {
        return true;
      }
    }
  }
  return false;
};

const isShortSampleLimitation = (text: string): boolean =>
  shortSampleLanguagePattern.test(text) || shortSampleAnswerCountPattern.test(text);

const shouldDropModelLimitation = (text: string, evidenceSummary: ReviewEvidenceSummary): boolean =>
  evidenceSummary.answer_count >= 8 &&
  isShortSampleLimitation(text);

const stripOrphanLeadingPunctuation = (text: string): string =>
  text.trim().replace(/^[\s。！？；：，、,.!?;:]+/u, "").trim();

const sanitizeGeneratedText = (text: string, evidenceSummary: ReviewEvidenceSummary): string => {
  const normalizedText = stripOrphanLeadingPunctuation(text);
  if (!isInformativeConclusion(normalizedText)) {
    return generatedTextFallback(evidenceSummary);
  }
  if (
    evidenceSummary.answer_count < 8 ||
    (!hasConflictingAnswerCount(normalizedText, evidenceSummary.answer_count) &&
      !shortSampleLanguagePattern.test(normalizedText) &&
      !generatedEventCountPattern.test(normalizedText))
  ) {
    return normalizedText;
  }
  generatedEventCountPattern.lastIndex = 0;
  const sanitized = normalizedText
    .replace(/[，,；;]?\s*(?:但|不过|然而)?(?:鉴于|由于|因为)?[^。.!?；;]*?(?:仅有|仅基于|只有|只基于|基于)\s*\d+\s*条(?:用户)?回答[^。.!?；;]*/g, "")
    .replace(/[，,；;]?\s*(?:且|并且|同时)?(?:用户)?回答(?:数量|数)?(?:为|是|共|共有|总计|合计)\s*\d+\s*条/g, "")
    .replace(/[，,；;]?\s*[^。.!?；;]*?(?:当前|本次演练(?:的)?|本轮(?:的)?|基于|引用|来自|包含|共有)\s*\d+\s*条(?:用户)?回答[^。.!?；;]*/g, "")
    .replace(generatedEventCountPattern, "完整对话")
    .replace(/[，,；;]?\s*[^。.!?；;]*?(?:短样本|样本(?:量)?较(?:小|短)|低可信|不宜推断长期能力|不能代表稳定能力判断)[^。.!?；;]*/g, "")
    .replace(/([。.!?])\s*[。.!?]+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > 0 && isInformativeConclusion(sanitized)
    ? sanitized
    : generatedTextFallback(evidenceSummary);
};

const sanitizeGeneratedReviewLanguage = (
  review: GeneratedReview,
  evidenceSummary: ReviewEvidenceSummary
): GeneratedReview => {
  const fallbackText = generatedTextFallback(evidenceSummary);
  const uncertaintyNotes = review.uncertainty_notes
    .filter(isInformativeConclusion)
    .filter((note) => !shouldDropModelLimitation(note, evidenceSummary))
    .map((note) => sanitizeGeneratedText(note, evidenceSummary))
    .filter((note) => note.length > 0 && note !== fallbackText);
  const recommendations = review.recommendations
    .filter((recommendation) => isInformativeConclusion(recommendation.text))
    .map((recommendation) => ({
      ...recommendation,
      text: sanitizeGeneratedText(recommendation.text, evidenceSummary),
      ...(recommendation.uncertainty_note === undefined
        ? {}
        : {
          uncertainty_note: shouldDropModelLimitation(recommendation.uncertainty_note, evidenceSummary)
            ? "本条建议仍需结合其他评估方式验证。"
            : sanitizeGeneratedText(recommendation.uncertainty_note, evidenceSummary)
        })
    }))
    .filter((recommendation) => recommendation.text !== fallbackText);
  return {
    ...review,
    summary: sanitizeGeneratedText(review.summary, evidenceSummary),
    dimensions: review.dimensions.map((dimension) => ({
      ...dimension,
      conclusion: sanitizeGeneratedText(dimension.conclusion, evidenceSummary) === fallbackText
        ? invalidGeneratedConclusion(dimension.name)
        : sanitizeGeneratedText(dimension.conclusion, evidenceSummary)
    })),
    recommendations: recommendations.length > 0
      ? recommendations
      : [{ text: "结合本轮可观察证据补充更具体的下一步行动。", evidence_refs: review.evidence_refs }],
    uncertainty_notes: uncertaintyNotes.length > 0
      ? Array.from(new Set(uncertaintyNotes))
      : [`本次复盘引用 ${evidenceSummary.answer_count} 条用户回答；仍需结合其他评估方式。`]
  };
};

const alignRecommendationsWithUserMoments = (
  recommendations: readonly ReviewRecommendation[],
  keyMoments: readonly ReviewKeyMoment[],
  evidence: readonly ReviewEvidenceItem[]
): ReviewRecommendation[] => {
  const userEvidenceKeys = new Set(evidence.filter((item) => item.actor_kind === "user").map((item) => refKey(item.ref)));
  const userMomentRefs = uniqueRefs(keyMoments.map((moment) => moment.evidence_ref).filter((ref) => userEvidenceKeys.has(refKey(ref))));
  if (userMomentRefs.length === 0) {
    return [...recommendations];
  }
  return recommendations.map((recommendation) => {
    if (recommendation.evidence_refs === undefined) {
      return recommendation;
    }
    const hasUserEvidence = recommendation.evidence_refs.some((ref) => userEvidenceKeys.has(refKey(ref)));
    return {
      ...recommendation,
      evidence_refs: hasUserEvidence
        ? uniqueRefs([...recommendation.evidence_refs, ...userMomentRefs])
        : userMomentRefs
    };
  });
};

const buildTopLevelEvidenceRefs = (review: ReviewRefContainer): ReviewEvidenceRef[] =>
  uniqueRefs(collectRefs(review));

const looksOffTopic = (text: string): boolean =>
  /不知道你在问什么|答非所问|无关|不相关|今天午饭|天气很好|随便聊/.test(text);

const looksContradictory = (texts: readonly string[]): boolean => {
  const joined = texts.join("\n");
  const negativeOwnership = /没有参与|未参与|没参与|只是旁观|不负责|没有做过/.test(joined);
  const positiveOwnership = /我主导|由我主导|我负责|全部由我|我推进|我完成/.test(joined);
  return negativeOwnership && positiveOwnership;
};

const buildCredibilityChecks = (
  evidence: readonly ReviewEvidenceItem[],
  evidenceSummary: ReviewEvidenceSummary,
  dimensions: readonly ReviewDimension[] = [],
  requiredDimensionNames: ReadonlySet<string> = new Set()
): ReviewCredibilityCheck[] => {
  const checks: ReviewCredibilityCheck[] = [];
  const userEvidence = evidence.filter((item) => item.actor_kind === "user");
  const userTexts = userEvidence.flatMap((item) => {
    const text = firstReadableEvidenceText(item);
    return text === null ? [] : [{ text, ref: item.ref }];
  });

  if (evidenceSummary.coverage === "insufficient") {
    checks.push({
      kind: "evidence_gap",
      severity: "warning",
      message: `证据不足：本次复盘基于 ${evidenceSummary.cited_answer_count}/${evidenceSummary.answer_count} 条用户回答生成。`
    });
  }

  for (const dimension of dimensions) {
    if (requiredDimensionNames.has(dimension.name) && dimension.evidence_refs.length === 0 && dimension.conclusion.startsWith("证据不足")) {
      checks.push({
        kind: "evidence_gap",
        severity: "warning",
        message: `证据不足：${dimension.name} 缺少可观察证据，结论置信度已降级。`
      });
    }
    if (
      requiredDimensionNames.has(dimension.name) &&
      dimension.evidence_refs.length > 0 &&
      dimension.conclusion.includes("模型未返回有效维度结论")
    ) {
      checks.push({
        kind: "evidence_gap",
        severity: "warning",
        message: `证据有限：${dimension.name} 有可观察证据，但维度结论不完整，结论置信度已降级。`
      });
    }
  }

  const offTopic = userTexts.find((item) => looksOffTopic(item.text));
  if (offTopic !== undefined) {
    checks.push({
      kind: "off_topic",
      severity: "warning",
      message: "发现答非所问信号：有回答没有回应当前问题，需要回到问题本身。",
      evidence_refs: [offTopic.ref]
    });
  }

  if (looksContradictory(userTexts.map((item) => item.text))) {
    checks.push({
      kind: "contradiction",
      severity: "warning",
      message: "发现前后矛盾信号：回答中同时出现未参与和主导完成的表述，需要澄清真实职责。",
      evidence_refs: userTexts.map((item) => item.ref)
    });
  }

  return checks.length > 0 ? checks : [{
    kind: "evidence_gap",
    severity: "info",
    message: `本次复盘引用 ${evidenceSummary.cited_answer_count}/${evidenceSummary.answer_count} 条用户回答，未发现稳定的答非所问或前后矛盾信号。`
  }];
};

type GenerateReviewAttemptResult =
  | { readonly ok: true; readonly review: GeneratedReview }
  | { readonly ok: false; readonly error_message: ReviewGenerationError };

const reviewRetryPrompt = (prompt: string, errorMessage: ReviewGenerationError): string =>
  `${prompt}\n\nPrevious review output was rejected with ${errorMessage}. Return only strict JSON matching the requested schema. Do not omit required fields. Do not include markdown or commentary.`;

const generateReviewAttempt = async (
  input: GenerateReviewReportInput,
  prompt: string,
  evidence: readonly ReviewEvidenceItem[]
): Promise<GenerateReviewAttemptResult> => {
  let response: ReviewModelResponse;
  try {
    response = await input.adapter.complete({ prompt });
  } catch {
    return { ok: false, error_message: "review_model_failed" };
  }
  if (response.content.trim().length === 0) {
    return { ok: false, error_message: "review_model_empty" };
  }

  const generated = parseGeneratedReview(response.content);
  if (!generated.ok) {
    return { ok: false, error_message: generated.error_message };
  }
  if (!refsAreValid(generated.review, evidence)) {
    return { ok: false, error_message: "review_evidence_ref_invalid" };
  }
  const rubricApplied = applyScenarioRubric(generated.review, input.scenario, evidence);
  if (!rubricApplied.ok) {
    return { ok: false, error_message: rubricApplied.error_message };
  }
  if (!refsAreValid(rubricApplied.review, evidence)) {
    return { ok: false, error_message: "review_evidence_ref_invalid" };
  }

  return { ok: true, review: rubricApplied.review };
};

export const generateReviewReport = async (input: GenerateReviewReportInput): Promise<ReviewReport> => {
  const evidence = extractReviewEvidence({ session_id: input.session_id, scenario: input.scenario, events: input.events });
  if (evidence.length === 0) {
    return failedReport(input, "review_evidence_empty");
  }

  const prompt = renderReviewPrompt({ session_id: input.session_id, scenario: input.scenario, evidence });
  let attempt = await generateReviewAttempt(input, prompt, evidence);
  if (!attempt.ok) {
    attempt = await generateReviewAttempt(input, reviewRetryPrompt(prompt, attempt.error_message), evidence);
  }
  if (!attempt.ok) {
    return failedReport(input, attempt.error_message);
  }

  const readableKeyMoments = buildReadableKeyMoments(attempt.review, evidence);
  if (readableKeyMoments.length === 0) {
    return failedReport(input, "review_evidence_ref_invalid");
  }

  const now = input.now();
  const recommendations = alignRecommendationsWithUserMoments(attempt.review.recommendations, readableKeyMoments, evidence);
  const finalReview = {
    ...attempt.review,
    key_moments: readableKeyMoments,
    recommendations,
    evidence_refs: buildTopLevelEvidenceRefs({
      ...attempt.review,
      key_moments: readableKeyMoments,
      recommendations
    })
  };
  const baseEvidenceSummary = buildEvidenceSummary(finalReview, evidence);
  const languageSanitizedReview = sanitizeGeneratedReviewLanguage(finalReview, baseEvidenceSummary);
  const requiredDimensionNames = new Set(
    input.scenario.review_rubric.dimensions
      .filter((dimension) => dimension.evidence_requirement === "required")
      .map((dimension) => dimension.title)
  );
  const credibilityChecks = buildCredibilityChecks(evidence, baseEvidenceSummary, languageSanitizedReview.dimensions, requiredDimensionNames);
  const evidenceSummary = downgradeConfidenceForWarnings(baseEvidenceSummary, credibilityChecks);
  const shortSampleNote = shortSampleUncertaintyNote(evidenceSummary.answer_count);
  const finalReviewWithUncertainty = {
    ...languageSanitizedReview,
    uncertainty_notes: shortSampleNote === null
      ? languageSanitizedReview.uncertainty_notes
      : Array.from(new Set([...languageSanitizedReview.uncertainty_notes, shortSampleNote]))
  };
  return ReviewReportSchema.parse({
    id: input.review_id,
    session_id: input.session_id,
    status: "succeeded",
    created_at: now,
    completed_at: now,
    ...finalReviewWithUncertainty,
    evidence_summary: evidenceSummary,
    credibility_checks: credibilityChecks
  });
};

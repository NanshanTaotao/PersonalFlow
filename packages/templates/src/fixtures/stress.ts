import type { NormalizedScenarioV1 } from "@personalflow/contracts";

import { createJobInterviewFixture } from "./job-interview";
import { createPromotionReviewFixture } from "./promotion-review";

export const stressFixtureDrafts: readonly NormalizedScenarioV1[] = [
  {
    ...createJobInterviewFixture({
      target_role: "Who Is Undercover facilitator",
      company_stage: "party game",
      interview_focus: "hidden role deduction",
      max_turns: 2
    }),
    id: "stress_who_is_undercover",
    title: "谁是卧底草案",
    description: "非 MVP 表达力草案，不进入产品模板入口。"
  },
  {
    ...createPromotionReviewFixture({
      target_level: "Staff Engineer",
      review_cycle: "salary negotiation",
      impact_focus: "compensation negotiation evidence",
      max_turns: 2
    }),
    id: "stress_salary_negotiation",
    title: "薪资谈判草案",
    description: "非 MVP 表达力草案，不进入产品模板入口。"
  }
];

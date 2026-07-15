import { z } from "zod";

export const ApiErrorCodeSchema = z.enum([
  "validation_error",
  "conflict",
  "model_error",
  "permission_error",
  "scenario_quality_blocked",
  "scenario_error",
  "storage_error"
]);

export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z
  .object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1),
    details: z.unknown().optional()
  })
  .strict();

export type ApiError = z.infer<typeof ApiErrorSchema>;

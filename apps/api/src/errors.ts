import type { ApiErrorCode } from "@personalflow/contracts";
import { RuntimeError } from "@personalflow/runtime";
import { StorageError } from "@personalflow/storage";
import { ZodError } from "zod";

export interface ProductApiErrorResponse {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly details?: unknown;
  };
}

export class ProductApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly statusCode: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ProductApiError";
  }
}

export const validationError = (message = "Request validation failed.", details?: unknown): ProductApiError =>
  new ProductApiError("validation_error", 400, message, details);

export const conflictError = (message = "Request conflicts with current state.", details?: unknown): ProductApiError =>
  new ProductApiError("conflict", 409, message, details);

export const scenarioError = (message = "Scenario operation failed.", statusCode = 400, details?: unknown): ProductApiError =>
  new ProductApiError("scenario_error", statusCode, message, details);

export const modelError = (message = "Model operation failed.", details?: unknown): ProductApiError =>
  new ProductApiError("model_error", 502, message, details);

export const permissionError = (message = "Permission denied.", details?: unknown): ProductApiError =>
  new ProductApiError("permission_error", 403, message, details);

export const toApiError = (error: unknown): ProductApiError => {
  if (error instanceof ProductApiError) {
    return error;
  }
  if (error instanceof ZodError) {
    return validationError("Request validation failed.", error.issues.map((issue) => ({ path: issue.path, code: issue.code })));
  }
  if (error instanceof RuntimeError) {
    if (error.code === "conflict") {
      return conflictError("State version conflict.");
    }
    return scenarioError("Runtime rejected the operation.", 400);
  }
  if (error instanceof StorageError) {
    if (error.code === "storage_conflict") {
      return conflictError("Storage conflict.");
    }
    if (error.code === "storage_not_found") {
      return scenarioError("Resource does not exist.", 404);
    }
    return new ProductApiError("storage_error", 500, "Storage operation failed.");
  }
  if (error instanceof Error && error.name === "TemplateBuildError") {
    return scenarioError("Template request is invalid.", 400);
  }
  return new ProductApiError("storage_error", 500, "Internal API operation failed.");
};

export const serializeApiError = (error: ProductApiError): ProductApiErrorResponse => {
  const payload = {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details })
  };
  return { error: payload };
};

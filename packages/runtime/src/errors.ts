import type { ApiErrorCode } from "@personalflow/contracts";

export class RuntimeError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

export class RuntimeConflictError extends RuntimeError {
  constructor(message = "State version conflict.") {
    super("conflict", message);
    this.name = "RuntimeConflictError";
  }
}

export class RuntimeValidationError extends RuntimeError {
  constructor(message: string) {
    super("validation_error", message);
    this.name = "RuntimeValidationError";
  }
}

export class ReplayStateVersionError extends RuntimeError {
  constructor(message = "Replay state version is inconsistent.") {
    super("conflict", message);
    this.name = "ReplayStateVersionError";
  }
}

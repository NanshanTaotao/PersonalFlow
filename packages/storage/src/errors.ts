export type StorageErrorCode = "storage_conflict" | "storage_not_found" | "storage_validation" | "storage_io";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly cause?: unknown;

  constructor(code: StorageErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.cause = cause;
  }
}

const hasSqliteConstraintCode = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  error.code.startsWith("SQLITE_CONSTRAINT");

export const toStorageError = (error: unknown): StorageError => {
  if (error instanceof StorageError) {
    return error;
  }
  if (hasSqliteConstraintCode(error)) {
    return new StorageError("storage_conflict", "Storage constraint conflict.", error);
  }
  if (error instanceof Error) {
    return new StorageError("storage_io", error.message, error);
  }
  return new StorageError("storage_io", "Storage operation failed.", error);
};

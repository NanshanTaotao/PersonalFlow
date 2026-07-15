import type { RuntimeUnitOfWork } from "@personalflow/contracts";

import type { StorageDatabase } from "./db";
import { SqliteRuntimeStore } from "./runtime-store";

export const createRuntimeUnitOfWork = (database: StorageDatabase): RuntimeUnitOfWork =>
  new SqliteRuntimeStore(database);

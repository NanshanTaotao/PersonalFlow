import type { RuntimeStoreContext } from "@personalflow/contracts";

import type { StorageDatabase } from "./db";
import { SqliteSessionBranchRepository } from "./repositories/session-branches";
import { SqliteRuntimeEventStore, SqliteRuntimeSessionStore } from "./runtime-store";

export interface ProductStoreContext {
  readonly runtime: RuntimeStoreContext;
  readonly branches: SqliteSessionBranchRepository;
}

export class SqliteProductStore {
  constructor(private readonly database: StorageDatabase) {}

  async transaction<T>(fn: (stores: ProductStoreContext) => Promise<T>): Promise<T> {
    this.database.sqlite.exec("begin immediate");
    try {
      const context: ProductStoreContext = {
        runtime: {
          sessions: new SqliteRuntimeSessionStore(this.database),
          events: new SqliteRuntimeEventStore(this.database)
        },
        branches: new SqliteSessionBranchRepository(this.database)
      };
      const result = await fn(context);
      this.database.sqlite.exec("commit");
      return result;
    } catch (error) {
      this.database.sqlite.exec("rollback");
      throw error;
    }
  }
}

export const createProductStore = (database: StorageDatabase): SqliteProductStore =>
  new SqliteProductStore(database);

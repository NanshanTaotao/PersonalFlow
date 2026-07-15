import type { StorageDatabase } from "./db";
import { createConfirmedScenesRepository, createSceneDraftsRepository } from "./repositories/scenes";
import { createMaterialsRepository } from "./repositories/materials";
import { createModelConfigsRepository } from "./repositories/model-configs";
import { createReviewReportsRepository } from "./repositories/reviews";

export const personalFlowStoragePackage = "@personalflow/storage";

export const createRepositories = (database: StorageDatabase) => ({
  modelConfigs: createModelConfigsRepository(database),
  sceneDrafts: createSceneDraftsRepository(database),
  confirmedScenes: createConfirmedScenesRepository(database),
  reviewReports: createReviewReportsRepository(database),
  materials: createMaterialsRepository(database)
});

export type StorageRepositories = ReturnType<typeof createRepositories>;

export * from "./db";
export * from "./errors";
export * from "./runtime-store";
export * from "./product-store";
export * from "./transaction";
export * from "./schema";
export * from "./repositories/session-branches";
export * from "./repositories/model-configs";
export * from "./repositories/scenes";
export * from "./repositories/reviews";
export * from "./repositories/materials";

import type { JsonObject } from "@personalflow/contracts";
import { JsonObjectSchema } from "@personalflow/contracts";

import type { StorageDatabase } from "../db";
import { toStorageError } from "../errors";
import { parseJson, stringifyJson } from "../json";

export interface MaterialRecord {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly content: JsonObject;
  readonly created_at: string;
}

export interface MaterialSummary {
  readonly id: string;
  readonly title: string;
  readonly source_label: string;
  readonly summary: string;
  readonly created_at: string;
}

export interface CreateMaterialInput {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly content: JsonObject;
  readonly created_at: string;
}

interface MaterialRow {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly content_json: string;
  readonly created_at: string;
}

const materialFromRow = (row: MaterialRow): MaterialRecord => ({
  id: row.id,
  source: row.source,
  title: row.title,
  content: parseJson(row.content_json, JsonObjectSchema),
  created_at: row.created_at
});

const clampRecentLimit = (limit = 10): number =>
  Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;

const sensitivePattern = /authorization|bearer|api.?key|sk-[a-z0-9_-]+|secret|token|password|provider raw|raw prompt/gi;

const redactSensitiveText = (value: string): string =>
  value.replace(sensitivePattern, "[已隐藏]");

const firstTextValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const item of Object.values(value)) {
      const text = firstTextValue(item);
      if (text.length > 0) {
        return text;
      }
    }
  }
  return "";
};

const normalizedMaterialText = (material: MaterialRecord): string =>
  redactSensitiveText(firstTextValue(material.content)).replace(/\s+/g, " ").trim();

export const materialSourceLabel = (source: string): string =>
  source === "manual" ? "手动粘贴" : source;

export const materialContextText = (material: MaterialRecord): string =>
  normalizedMaterialText(material);

export const materialSummary = (material: MaterialRecord): MaterialSummary => {
  const text = normalizedMaterialText(material);
  return {
    id: material.id,
    title: material.title,
    source_label: materialSourceLabel(material.source),
    summary: text.length === 0 ? "已保存材料，可用于演练上下文。" : `已保存 ${text.length} 字材料，可用于演练上下文。`,
    created_at: material.created_at
  };
};

export class MaterialsRepository {
  constructor(private readonly database: StorageDatabase) {}

  async create(input: CreateMaterialInput): Promise<MaterialRecord> {
    try {
      const content = JsonObjectSchema.parse(input.content);
      this.database.sqlite
        .prepare("insert into materials (id, source, title, content_json, created_at) values (?, ?, ?, ?, ?)")
        .run(input.id, input.source, input.title, stringifyJson(content), input.created_at);
      const material = await this.get(input.id);
      if (material === null) {
        throw new Error("Created material cannot be read.");
      }
      return material;
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async get(id: string): Promise<MaterialRecord | null> {
    try {
      const row = this.database.sqlite.prepare("select * from materials where id = ?").get(id) as
        | MaterialRow
        | undefined;
      return row === undefined ? null : materialFromRow(row);
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async listRecent(limit = 10): Promise<MaterialSummary[]> {
    try {
      const rows = this.database.sqlite
        .prepare("select * from materials order by created_at desc, id desc limit ?")
        .all(clampRecentLimit(limit)) as MaterialRow[];
      return rows.map((row) => materialSummary(materialFromRow(row)));
    } catch (error) {
      throw toStorageError(error);
    }
  }
}

export const createMaterialsRepository = (database: StorageDatabase): MaterialsRepository =>
  new MaterialsRepository(database);

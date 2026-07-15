import type { StorageDatabase } from "../db";
import { decryptSecret, encryptSecret, maskSecret } from "../crypto";
import { toStorageError } from "../errors";

export interface CreateModelConfigInput {
  readonly id: string;
  readonly provider: string;
  readonly base_url: string;
  readonly model: string;
  readonly display_name: string;
  readonly api_key: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ModelConfigSafe {
  readonly id: string;
  readonly provider: string;
  readonly base_url: string;
  readonly model: string;
  readonly display_name: string;
  readonly has_api_key: boolean;
  readonly api_key_masked: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ModelConfigForModelCall {
  readonly id: string;
  readonly provider: string;
  readonly base_url: string;
  readonly model: string;
  readonly api_key: string;
}

interface ModelConfigRow {
  readonly id: string;
  readonly provider: string;
  readonly base_url: string;
  readonly model: string;
  readonly display_name: string;
  readonly api_key_ciphertext: string;
  readonly api_key_iv: string;
  readonly api_key_tag: string;
  readonly is_default: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const toSafe = (row: ModelConfigRow, encryptionKey: Uint8Array): ModelConfigSafe => ({
  id: row.id,
  provider: row.provider,
  base_url: row.base_url,
  model: row.model,
  display_name: row.display_name,
  has_api_key: row.api_key_ciphertext.length > 0,
  api_key_masked:
    row.api_key_ciphertext.length > 0
      ? maskSecret(
          decryptSecret(
            {
              ciphertext: row.api_key_ciphertext,
              iv: row.api_key_iv,
              tag: row.api_key_tag
            },
            encryptionKey
          )
        )
      : null,
  created_at: row.created_at,
  updated_at: row.updated_at
});

export class ModelConfigsRepository {
  constructor(private readonly database: StorageDatabase) {}

  async create(input: CreateModelConfigInput): Promise<ModelConfigSafe> {
    try {
      const encrypted = encryptSecret(input.api_key, this.database.encryptionKey);
      const existingCount = this.database.sqlite.prepare("select count(*) as count from model_configs").get() as { count: number };
      this.database.sqlite
        .prepare(
          `insert into model_configs (
            id, provider, base_url, model, display_name,
            api_key_ciphertext, api_key_iv, api_key_tag, is_default, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.id,
          input.provider,
          input.base_url,
          input.model,
          input.display_name,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          existingCount.count === 0 ? 1 : 0,
          input.created_at,
          input.updated_at
        );
      return this.getSafe(input.id).then((config) => {
        if (config === null) {
          throw new Error("Created model config cannot be read.");
        }
        return config;
      });
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async listSafe(): Promise<ModelConfigSafe[]> {
    try {
      const rows = this.database.sqlite
        .prepare("select * from model_configs order by created_at asc, id asc")
        .all() as ModelConfigRow[];
      return rows.map((row) => toSafe(row, this.database.encryptionKey));
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async getSafe(id: string): Promise<ModelConfigSafe | null> {
    try {
      const row = this.database.sqlite.prepare("select * from model_configs where id = ?").get(id) as
        | ModelConfigRow
        | undefined;
      return row === undefined ? null : toSafe(row, this.database.encryptionKey);
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async getDefaultSafe(): Promise<ModelConfigSafe | null> {
    try {
      const row = this.database.sqlite
        .prepare("select * from model_configs where is_default = 1 order by created_at asc, id asc limit 1")
        .get() as ModelConfigRow | undefined;
      if (row !== undefined) {
        return toSafe(row, this.database.encryptionKey);
      }
      const fallback = this.database.sqlite
        .prepare("select * from model_configs order by created_at asc, id asc limit 1")
        .get() as ModelConfigRow | undefined;
      return fallback === undefined ? null : toSafe(fallback, this.database.encryptionKey);
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async getForModelCall(id: string): Promise<ModelConfigForModelCall | null> {
    try {
      const row = this.database.sqlite.prepare("select * from model_configs where id = ?").get(id) as
        | ModelConfigRow
        | undefined;
      if (row === undefined) {
        return null;
      }
      return {
        id: row.id,
        provider: row.provider,
        base_url: row.base_url,
        model: row.model,
        api_key: decryptSecret(
          {
            ciphertext: row.api_key_ciphertext,
            iv: row.api_key_iv,
            tag: row.api_key_tag
          },
          this.database.encryptionKey
        )
      };
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async getDefaultForModelCall(): Promise<ModelConfigForModelCall | null> {
    try {
      const row = this.database.sqlite
        .prepare("select * from model_configs where is_default = 1 order by created_at asc, id asc limit 1")
        .get() as ModelConfigRow | undefined;
      const fallback = row ?? this.database.sqlite
        .prepare("select * from model_configs order by created_at asc, id asc limit 1")
        .get() as ModelConfigRow | undefined;
      if (fallback === undefined) {
        return null;
      }
      return this.getForModelCall(fallback.id);
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async update(id: string, input: Partial<Omit<CreateModelConfigInput, "id" | "created_at">>): Promise<ModelConfigSafe> {
    try {
      const current = this.database.sqlite.prepare("select * from model_configs where id = ?").get(id) as ModelConfigRow | undefined;
      if (current === undefined) {
        throw new Error("Model config does not exist.");
      }
      const encrypted = input.api_key === undefined
        ? { ciphertext: current.api_key_ciphertext, iv: current.api_key_iv, tag: current.api_key_tag }
        : encryptSecret(input.api_key, this.database.encryptionKey);
      this.database.sqlite
        .prepare(
          `update model_configs
           set provider = ?, base_url = ?, model = ?, display_name = ?,
               api_key_ciphertext = ?, api_key_iv = ?, api_key_tag = ?, updated_at = ?
           where id = ?`
        )
        .run(
          input.provider ?? current.provider,
          input.base_url ?? current.base_url,
          input.model ?? current.model,
          input.display_name ?? current.display_name,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          input.updated_at ?? current.updated_at,
          id
        );
      const updated = await this.getSafe(id);
      if (updated === null) {
        throw new Error("Updated model config cannot be read.");
      }
      return updated;
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async setDefault(id: string): Promise<ModelConfigSafe> {
    try {
      const current = this.database.sqlite.prepare("select * from model_configs where id = ?").get(id) as ModelConfigRow | undefined;
      if (current === undefined) {
        throw new Error("Model config does not exist.");
      }
      const transaction = this.database.sqlite.transaction(() => {
        this.database.sqlite.prepare("update model_configs set is_default = 0").run();
        this.database.sqlite.prepare("update model_configs set is_default = 1 where id = ?").run(id);
      });
      transaction();
      const modelConfig = await this.getSafe(id);
      if (modelConfig === null) {
        throw new Error("Default model config cannot be read.");
      }
      return modelConfig;
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const current = this.database.sqlite.prepare("select * from model_configs where id = ?").get(id) as ModelConfigRow | undefined;
      this.database.sqlite.prepare("delete from model_configs where id = ?").run(id);
      if (current?.is_default === 1) {
        const next = this.database.sqlite
          .prepare("select id from model_configs order by created_at asc, id asc limit 1")
          .get() as { id: string } | undefined;
        if (next !== undefined) {
          this.database.sqlite.prepare("update model_configs set is_default = 1 where id = ?").run(next.id);
        }
      }
    } catch (error) {
      throw toStorageError(error);
    }
  }
}

export const createModelConfigsRepository = (database: StorageDatabase): ModelConfigsRepository =>
  new ModelConfigsRepository(database);

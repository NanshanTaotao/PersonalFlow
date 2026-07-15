import { z } from "zod";

export const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export type JsonValue = z.infer<typeof JsonPrimitiveSchema> | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)])
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export type JsonObject = z.infer<typeof JsonObjectSchema>;

export type JsonSchemaValue =
  | boolean
  | {
      type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null" | undefined;
      properties?: Record<string, JsonSchemaValue> | undefined;
      items?: JsonSchemaValue | undefined;
      required?: string[] | undefined;
      additionalProperties?: boolean | JsonSchemaValue | undefined;
      enum?: JsonValue[] | undefined;
      const?: JsonValue | undefined;
      minimum?: number | undefined;
      maximum?: number | undefined;
      minLength?: number | undefined;
      maxLength?: number | undefined;
      description?: string | undefined;
    };

export const JsonSchemaValueSchema: z.ZodType<JsonSchemaValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z
      .object({
        type: z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]).optional(),
        properties: z.record(z.string(), JsonSchemaValueSchema).optional(),
        items: JsonSchemaValueSchema.optional(),
        required: z.array(z.string().min(1)).optional(),
        additionalProperties: z.union([z.boolean(), JsonSchemaValueSchema]).optional(),
        enum: z.array(JsonValueSchema).optional(),
        const: JsonValueSchema.optional(),
        minimum: z.number().optional(),
        maximum: z.number().optional(),
        minLength: z.number().int().nonnegative().optional(),
        maxLength: z.number().int().nonnegative().optional(),
        description: z.string().optional()
      })
      .strict()
  ])
);

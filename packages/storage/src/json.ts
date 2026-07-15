interface Parser<T> {
  parse(value: unknown): T;
}

export const stringifyJson = (value: unknown): string => JSON.stringify(value);

export const parseJson = <T>(raw: string, parser: Parser<T>): T => parser.parse(JSON.parse(raw) as unknown);

export const parseNullableJson = <T>(raw: string | null, parser: Parser<T>): T | undefined =>
  raw === null ? undefined : parseJson(raw, parser);

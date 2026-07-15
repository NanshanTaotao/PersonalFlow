const idPrefixPattern = /^[a-z][a-z0-9_]*$/;

export function createId(prefix: string): string {
  if (!idPrefixPattern.test(prefix)) {
    throw new Error(`Invalid id prefix: ${prefix}`);
  }

  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

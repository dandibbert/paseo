// React keys for validated GenUI data, which carries no ids. Keys come from content, with
// an occurrence suffix so identical rows stay distinct; the data never reorders.
export function withContentKeys<T>(items: readonly T[]): Array<{ key: string; item: T }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = JSON.stringify(item) ?? "";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { key: `${base}#${count}`, item };
  });
}

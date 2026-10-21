/** Id of the tab a WAI-ARIA tablist key should select, or undefined for other keys. */
export function tabForKey(ids: string[], current: string, key: string): string | undefined {
  const last = ids.length - 1;
  const i = ids.indexOf(current);
  if (key === "Home") return ids[0];
  if (key === "End") return ids[last];
  if (key === "ArrowRight") return ids[i === last ? 0 : i + 1];
  if (key === "ArrowLeft") return ids[i <= 0 ? last : i - 1];
  return undefined;
}

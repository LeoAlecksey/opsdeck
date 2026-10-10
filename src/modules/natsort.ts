/** Natural order for names: 1, 2, 10 (not 1, 10, 2), case-insensitive: "TL-2" < "TL-10". */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const natCmp = (a: string, b: string): number => collator.compare(a, b);

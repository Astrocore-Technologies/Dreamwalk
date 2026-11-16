/**
 * Cheap, offline checks for the failures seen in live roleplay: characters that mirror each
 * other, replies that all end in a question, and a speaker that repeats the previous line.
 * Pure functions over plain text; no model, no network. Used by tests and the evaluation kit.
 */
export interface ProseLine {
  speaker: string;
  text: string;
}
const words = (text: string) =>
  text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
const grams = (list: string[], size: number) => {
  const set = new Set<string>();
  for (let i = 0; i + size <= list.length; i++) set.add(list.slice(i, i + size).join(' '));
  return set;
};
/** Share of the shorter line's word triples that also occur in the other line (0..1). */
export function overlap(a: string, b: string): number {
  const x = grams(words(a), 3),
    y = grams(words(b), 3);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared++;
  return shared / Math.min(x.size, y.size);
}
export interface ProseReport {
  lines: number;
  /** Pairs of consecutive lines by different speakers that largely repeat each other. */
  mirroredPairs: [number, number][];
  /** Share of lines that end with a question mark. */
  questionEndRate: number;
  /** Consecutive lines by the same speaker that repeat themselves. */
  selfRepeats: number;
}
export function proseReport(lines: ProseLine[], mirrorThreshold = 0.25): ProseReport {
  const mirroredPairs: [number, number][] = [];
  let selfRepeats = 0;
  for (let i = 1; i < lines.length; i++) {
    const score = overlap(lines[i - 1].text, lines[i].text);
    if (lines[i - 1].speaker !== lines[i].speaker && score >= mirrorThreshold)
      mirroredPairs.push([i - 1, i]);
    if (lines[i - 1].speaker === lines[i].speaker && score >= mirrorThreshold) selfRepeats++;
  }
  const questions = lines.filter((line) => /[?？]\s*[*"»”)]*\s*$/.test(line.text.trim())).length;
  return {
    lines: lines.length,
    mirroredPairs,
    questionEndRate: lines.length ? questions / lines.length : 0,
    selfRepeats,
  };
}

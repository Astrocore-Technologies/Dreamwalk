/** Author text may carry Markdown (headings, bold, lists); AI prompts only need the words. */
export const plainText = (text: string) =>
  text
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_`]{1,3}/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

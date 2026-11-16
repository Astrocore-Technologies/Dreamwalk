import { plainText } from '../text/plain';

/**
 * The saved NPC appearance may be up to 4000 characters of Markdown, while the character brief
 * keeps the short `appearance` (500) and the full `description` (2000). Use plain words and cut to
 * the limits instead of failing validation.
 */
export function characterBriefTexts(source: string) {
  const text = plainText(source);
  return { description: text.slice(0, 2000).trim(), appearance: text.slice(0, 500).trim() };
}

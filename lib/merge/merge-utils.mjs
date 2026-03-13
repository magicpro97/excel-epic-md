import { MERGE_CONFIG } from '../config/config.mjs';

/**
 * Extract best title from chunk results
 * @param {Array<object>} chunks - Chunk results with epic.title
 * @param {RegExp} filterPattern - Pattern to filter out unwanted titles
 * @param {string} fallback - Fallback title if none found
 * @returns {string} Best title found
 */
function extractBestTitle(chunks, filterPattern, fallback) {
  const allTitles = chunks
    .map((c) => c.epic?.title)
    .filter((t) => t && !filterPattern.test(t) && t.length > MERGE_CONFIG.MIN_TITLE_LENGTH);
  return allTitles[0] || fallback;
}

/**
 * Clean and filter open questions, removing OCR noise
 * @param {Array<object>} chunks - Chunk results with openQuestions
 * @returns {Array<object>} Cleaned open questions
 */
function extractCleanOpenQuestions(chunks) {
  return chunks
    .flatMap((c) => c.openQuestions || [])
    .filter((q) => {
      if (!q) return false;
      const text = typeof q === 'string' ? q : q.question;
      if (!text || text.length < MERGE_CONFIG.MIN_QUESTION_LENGTH) return false;
      // Filter out OCR garbage patterns (non-text characters, error keywords)
      return !(/^[^a-zA-Z\u3040-\u30FF\u4E00-\u9FFF]{3,}$/.test(text) || /chunk|error|failed/i.test(text));
    })
    .slice(0, MERGE_CONFIG.MAX_OPEN_QUESTIONS);
}

/**
 * Remove duplicate items by ID field
 * @param {Array<{id?: string}>} items - Array of items with optional id field
 * @returns {Array<object>} Deduplicated array
 */
function deduplicateById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item.id) return true;
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export { deduplicateById, extractBestTitle, extractCleanOpenQuestions };

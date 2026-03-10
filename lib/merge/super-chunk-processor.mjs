import fs from 'fs';
import { MERGE_CONFIG } from '../config/config.mjs';
import { log } from '../utils/logger.mjs';
import { sleep, isRetryableMessage } from '../utils/helpers.mjs';
import { extractBestTitle, extractCleanOpenQuestions, deduplicateById } from './merge-utils.mjs';
import { SYSTEM_INSTRUCTION } from '../prompts/system-instruction.mjs';
import { mergeSynthesisPrompt, createFinalMergePrompt } from '../prompts/merge-prompt.mjs';
import { generateWithFallback } from '../processing/fallback.mjs';

/**
 * Create fallback result when super-chunk merge fails
 * @param {number} superChunkId - Super-chunk ID
 * @param {string} chunkIds - Comma-separated chunk IDs
 * @param {Array<object>} sourceChunks - Source chunk results
 * @returns {object} Fallback merged result
 */
function createSuperChunkFallback(superChunkId, chunkIds, sourceChunks) {
  const bestTitle = extractBestTitle(sourceChunks, /^(Chunk|failed)/i, `Phần ${chunkIds}`);

  return {
    superChunkId,
    sourceChunks: chunkIds,
    epic: {
      title: bestTitle,
      summary: sourceChunks
        .map((c) => c.epic?.summary || '')
        .filter(Boolean)
        .join(' ')
        .slice(0, MERGE_CONFIG.SUPER_CHUNK_SUMMARY_MAX_LENGTH),
    },
    requirements: sourceChunks.flatMap((c) => c.requirements || []),
    tasks: sourceChunks.flatMap((c) => c.tasks || []),
    openQuestions: sourceChunks
      .flatMap((c) => c.openQuestions || [])
      .filter(
        (q) =>
          q &&
          (typeof q === 'string'
            ? q.length > MERGE_CONFIG.MIN_QUESTION_LENGTH
            : q.question?.length > MERGE_CONFIG.MIN_QUESTION_LENGTH),
      ),
  };
}

/**
 * Create final direct merge result (fallback when too many super-chunks)
 * @param {Array<object>} superChunkResults - Super-chunk results to merge
 * @returns {object} Final merged epic result
 */
function createDirectMergeResult(superChunkResults) {
  const bestTitle = extractBestTitle(superChunkResults, /^(Chunk|Super-chunk|Epic)/i, 'Epic Requirement');
  const cleanOpenQuestions = extractCleanOpenQuestions(superChunkResults);

  return {
    epic: {
      title: bestTitle,
      summary: superChunkResults
        .map((s) => s.epic?.summary || '')
        .filter(Boolean)
        .join(' ')
        .slice(0, MERGE_CONFIG.SUMMARY_MAX_LENGTH),
    },
    requirements: deduplicateById(superChunkResults.flatMap((s) => s.requirements || [])).sort((a, b) =>
      (a.id || '').localeCompare(b.id || ''),
    ),
    tasks: deduplicateById(superChunkResults.flatMap((s) => s.tasks || [])).sort((a, b) =>
      (a.id || '').localeCompare(b.id || ''),
    ),
    openQuestions: cleanOpenQuestions,
  };
}

/**
 * Process chunk merge with retry logic
 * @param {BaseLLMClient} client - LLM client
 * @param {Array<object>} chunk - Page summaries in chunk
 * @param {number} chunkIndex - Current chunk index
 * @param {number} totalChunks - Total number of chunks
 * @param {string} chunkRange - Page range string (e.g., "1-10")
 * @param {Array<object>} chunkResults - Array to push results to
 * @param {string|null} chunkResultsFile - Path to progress file
 * @returns {Promise<boolean>} True if should continue, false if quota exhausted
 */
async function processChunkWithRetry(
  client,
  chunk,
  chunkIndex,
  totalChunks,
  chunkRange,
  chunkResults,
  chunkResultsFile,
) {
  const maxRetries = MERGE_CONFIG.CHUNK_MAX_RETRIES;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const prompt = mergeSynthesisPrompt(chunk);

      // Phase 3: Use generateWithFallback for chunk processing
      const { result, usedFallback } = await generateWithFallback(client, prompt, SYSTEM_INSTRUCTION, {
        estimatedOutputTokens: chunk.length * 2000,
        pageCount: chunk.length,
      });

      chunkResults.push({
        chunkId: chunkIndex + 1,
        pageRange: chunkRange,
        usedFallback, // Track if fallback was used
        ...result,
      });

      if (usedFallback) {
        log('info', `✅ Chunk ${chunkIndex + 1} merged successfully (via OpenRouter fallback)`);
      } else {
        log('info', `✅ Chunk ${chunkIndex + 1} merged successfully`);
      }

      // Save progress after each successful chunk
      if (chunkResultsFile) {
        fs.writeFileSync(chunkResultsFile, JSON.stringify({ totalChunks, chunks: chunkResults }, null, 2));
      }
      return true;
    } catch (err) {
      // Use shared retry logic
      if (attempt < maxRetries && isRetryableMessage(err.message)) {
        const delay = MERGE_CONFIG.CHUNK_RETRY_DELAY_MS * attempt;
        log('warn', `⚠️ Chunk ${chunkIndex + 1} attempt ${attempt} failed, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      // Check if it's a quota exhaustion error - should stop pipeline
      if (err.message.includes('exhausted') || err.message.includes('quota')) {
        log('error', `🛑 Quota exhausted at chunk ${chunkIndex + 1}. Progress saved. Resume later.`);
        if (chunkResultsFile) {
          fs.writeFileSync(
            chunkResultsFile,
            JSON.stringify({ totalChunks, chunks: chunkResults, error: err.message }, null, 2),
          );
        }
        throw err;
      }

      // Non-retryable error - create placeholder and continue
      log('warn', `⚠️ Chunk ${chunkIndex + 1} failed after ${maxRetries} attempts: ${err.message.slice(0, 100)}`);
      chunkResults.push({
        chunkId: chunkIndex + 1,
        pageRange: chunkRange,
        error: err.message,
        epic: { title: `Chunk ${chunkIndex + 1} (pages ${chunkRange})`, summary: 'Merge failed - see error' },
        requirements: [],
        tasks: [],
        openQuestions: [{ question: `Chunk merge failed: ${err.message}`, context: 'System error' }],
      });
      return true;
    }
  }
  return true;
}

/**
 * Process super-chunks and merge results
 * @param {BaseLLMClient} client - LLM client
 * @param {Array<object>} chunkResults - Chunk results to merge
 * @param {number} finalChunkSize - Final chunk size threshold
 * @returns {Promise<Array<object>>} Super-chunk results
 */
async function processSuperChunks(client, chunkResults, finalChunkSize) {
  const superChunks = [];
  for (let i = 0; i < chunkResults.length; i += finalChunkSize) {
    superChunks.push(chunkResults.slice(i, i + finalChunkSize));
  }
  log('info', `📦 Split into ${superChunks.length} super-chunks`);

  const superChunkResults = [];
  for (let i = 0; i < superChunks.length; i++) {
    const superChunk = superChunks[i];
    const chunkIds = superChunk.map((c) => c.chunkId).join(',');
    log('info', `🔄 Merging super-chunk ${i + 1}/${superChunks.length} (chunks ${chunkIds})...`);

    try {
      const prompt = createFinalMergePrompt(superChunk);
      const { result } = await generateWithFallback(client, prompt, SYSTEM_INSTRUCTION, {
        estimatedOutputTokens: superChunk.length * 5000,
        pageCount: 0,
      });
      superChunkResults.push({ superChunkId: i + 1, sourceChunks: chunkIds, ...result });
      log('info', `✅ Super-chunk ${i + 1} merged`);
    } catch (err) {
      log('warn', `⚠️ Super-chunk ${i + 1} failed: ${err.message}, using smart fallback...`);
      superChunkResults.push(createSuperChunkFallback(i + 1, chunkIds, superChunk));
    }
  }
  return superChunkResults;
}

export { createSuperChunkFallback, createDirectMergeResult, processChunkWithRetry, processSuperChunks };

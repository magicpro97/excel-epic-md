import path from 'path';
import { GeminiClient } from '../llm-clients/gemini-client.mjs';
import { loadCachedChunkResults } from '../loaders/cache-loader.mjs';
import { generateWithFallback } from '../processing/fallback.mjs';
import { createFinalMergePrompt, mergeSynthesisPrompt } from '../prompts/merge-prompt.mjs';
import { SYSTEM_INSTRUCTION } from '../prompts/system-instruction.mjs';
import { log } from '../utils/logger.mjs';
import { determineChunkSizes } from './chunk-optimizer.mjs';
import { createDirectMergeResult, processChunkWithRetry, processSuperChunks } from './super-chunk-processor.mjs';

/**
 * Merge all page summaries into epic synthesis with hierarchical chunking.
 *
 * Supports progress saving to resume on failure.
 * @param {BaseLLMClient} client - LLM client (Gemini/OpenAI recommended)
 * @param {Array<object>} pageSummaries - Array of page summary objects
 * @param {string} [progressDir] - Directory to save progress (optional)
 * @returns {Promise<object>} Epic synthesis result
 */
async function mergeSynthesis(client, pageSummaries, progressDir = null) {
  log('info', '🔗 Starting merge synthesis...');

  const nonEmpty = pageSummaries.filter((p) => p.pageType !== 'empty' && p.pageType !== 'error' && p.extractedInfo);
  if (nonEmpty.length === 0) {
    throw new Error('No valid page summaries to merge');
  }

  const { chunkSize, finalChunkSize } = await determineChunkSizes(client, nonEmpty, progressDir);

  // Log estimation
  const chunksNeeded = Math.ceil(nonEmpty.length / chunkSize);
  const totalCallsEstimate = chunksNeeded + Math.ceil(chunksNeeded / finalChunkSize) + 1;
  log(
    'info',
    `📊 Merge estimation: ${nonEmpty.length} pages, ${chunkSize} chunk size, ~${totalCallsEstimate} API calls`,
  );

  // Check Gemini quota
  if (client instanceof GeminiClient) {
    const quota = client.getQuotaEstimate();
    if (quota.remaining < totalCallsEstimate) {
      log('warn', `⚠️ Estimated calls (${totalCallsEstimate}) may exceed remaining quota (${quota.remaining})`);
    }
  }

  // Small document - direct merge
  if (nonEmpty.length <= chunkSize) {
    const prompt = mergeSynthesisPrompt(nonEmpty);
    const { result } = await generateWithFallback(client, prompt, SYSTEM_INSTRUCTION, {
      estimatedOutputTokens: nonEmpty.length * 2000,
      pageCount: nonEmpty.length,
    });
    return result;
  }

  // Large document - hierarchical merge
  log('info', `📊 Large document (${nonEmpty.length} pages), using hierarchical merge...`);

  const chunks = [];
  for (let i = 0; i < nonEmpty.length; i += chunkSize) {
    chunks.push(nonEmpty.slice(i, i + chunkSize));
  }
  log('info', `📦 Split into ${chunks.length} chunks`);

  const chunkResultsFile = progressDir ? path.join(progressDir, 'chunk_results.json') : null;
  const { chunkResults, startIndex } = loadCachedChunkResults(chunkResultsFile, chunks.length);

  // Process chunks
  for (let i = startIndex; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkRange = `${chunk[0].pageNumber}-${chunk[chunk.length - 1].pageNumber}`;
    log('info', `🔄 Merging chunk ${i + 1}/${chunks.length} (pages ${chunkRange})...`);
    await processChunkWithRetry(client, chunk, i, chunks.length, chunkRange, chunkResults, chunkResultsFile);
  }

  // Final merge
  if (chunkResults.length <= finalChunkSize) {
    log('info', `🔗 Final merge of ${chunkResults.length} chunk results...`);
    try {
      const finalPrompt = createFinalMergePrompt(chunkResults);
      const { result } = await generateWithFallback(client, finalPrompt, SYSTEM_INSTRUCTION, {
        estimatedOutputTokens: chunkResults.length * 5000,
        pageCount: 0,
      });
      return result;
    } catch (err) {
      log('warn', `⚠️ LLM final merge failed: ${err.message.slice(0, 100)}`);
      log('info', '📦 Falling back to direct (programmatic) merge...');
      return createDirectMergeResult(chunkResults);
    }
  }

  // Hierarchical final merge
  log('info', `📊 Many chunks (${chunkResults.length}), using hierarchical final merge...`);
  const superChunkResults = await processSuperChunks(client, chunkResults, finalChunkSize);

  if (superChunkResults.length > finalChunkSize) {
    log('info', `📊 Still many super-chunks (${superChunkResults.length}), using smart direct merge...`);
    return createDirectMergeResult(superChunkResults);
  }

  log('info', `🔗 Final merge of ${superChunkResults.length} super-chunk results...`);
  try {
    const finalPrompt = createFinalMergePrompt(superChunkResults);
    const { result: finalResult } = await generateWithFallback(client, finalPrompt, SYSTEM_INSTRUCTION, {
      estimatedOutputTokens: superChunkResults.length * 5000,
      pageCount: 0,
    });
    return finalResult;
  } catch (err) {
    log('warn', `⚠️ LLM hierarchical final merge failed: ${err.message.slice(0, 100)}`);
    log('info', '📦 Falling back to direct (programmatic) merge...');
    return createDirectMergeResult(superChunkResults);
  }
}

export { mergeSynthesis };

import { CONFIG } from '../config/config.mjs';
import { batchExtractionPrompt } from '../prompts/page-prompts.mjs';
import { SYSTEM_INSTRUCTION } from '../prompts/system-instruction.mjs';
import { savePageCache } from '../utils/cache.mjs';
import { extractLargestPage, sleep, splitIntoBatches } from '../utils/helpers.mjs';
import { log } from '../utils/logger.mjs';

/**
 * Process a batch with shrink-on-error capability
 * If batch fails due to size/parse error, recursively split and retry
 * @param {BaseLLMClient} client - LLM client
 * @param {Array} batch - Batch of pages
 * @param {string} summariesDir - Path to save summaries
 * @param {number} depth - Recursion depth for logging
 * @returns {Promise<Array>} Array of page summaries
 */
async function processBatchWithShrink(client, batch, summariesDir, depth = 0) {
  const indent = '  '.repeat(depth + 2);
  const batchId = `[${batch[0].pageNumber}..${batch[batch.length - 1].pageNumber}]`;

  log('debug', `${indent}Processing batch ${batchId} (${batch.length} pages, depth=${depth})`);

  // Base case: single page
  if (batch.length === 1) {
    const page = batch[0];
    try {
      const prompt = batchExtractionPrompt([page]);
      const result = await client.generate(prompt, SYSTEM_INSTRUCTION);
      const pageResult = result.results?.[0] || result;
      pageResult.pageNumber = page.pageNumber;

      savePageCache(summariesDir, page.pageNumber, pageResult);
      log('info', `${indent}✅ Page ${page.pageNumber} completed`);
      return [pageResult];
    } catch (err) {
      log('error', `${indent}❌ Page ${page.pageNumber} failed: ${err.message}`);
      const errorResult = {
        pageNumber: page.pageNumber,
        pageType: 'error',
        error: err.message,
        extractedInfo: {},
        ambiguousTexts: [],
        openQuestions: [`Error: ${err.message}`],
      };
      savePageCache(summariesDir, page.pageNumber, errorResult);
      return [errorResult];
    }
  }

  // Try processing full batch
  try {
    const prompt = batchExtractionPrompt(batch);
    const result = await client.generate(prompt, SYSTEM_INSTRUCTION);
    const results = result.results || [result];

    const summaries = [];
    for (let i = 0; i < batch.length; i++) {
      const page = batch[i];
      const pageResult = results[i] || {
        pageNumber: page.pageNumber,
        pageType: 'error',
        extractedInfo: {},
        error: 'Missing in batch response',
      };
      pageResult.pageNumber = page.pageNumber;
      savePageCache(summariesDir, page.pageNumber, pageResult);
      summaries.push(pageResult);
    }

    log('info', `${indent}✅ Batch ${batchId} completed (${batch.length} pages)`);
    return summaries;
  } catch (err) {
    const isRecoverable =
      err.message.includes('413') ||
      err.message.includes('parse') ||
      err.message.includes('JSON') ||
      err.message.includes('rate limit');

    if (!isRecoverable || batch.length <= 1) {
      // Unrecoverable error or can't shrink further
      log('error', `${indent}❌ Batch ${batchId} unrecoverable: ${err.message}`);
      const errorResults = batch.map((page) => ({
        pageNumber: page.pageNumber,
        pageType: 'error',
        error: err.message,
        extractedInfo: {},
        ambiguousTexts: [],
        openQuestions: [`Error: ${err.message}`],
      }));
      for (const r of errorResults) {
        savePageCache(summariesDir, r.pageNumber, r);
      }
      return errorResults;
    }

    // Shrink and retry: extract largest page, process separately
    log('warn', `${indent}⚠️ Batch ${batchId} failed (${err.message.slice(0, 50)}...), shrinking...`);

    const { largest, rest } = extractLargestPage(batch);
    const results = [];

    // Process largest page individually
    log('debug', `${indent}  Isolating page ${largest.pageNumber} (largest)`);
    const largestResult = await processBatchWithShrink(client, [largest], summariesDir, depth + 1);
    results.push(...largestResult);

    // Wait before next request
    await sleep(CONFIG.requestDelayMs);

    // Process rest as new batch
    if (rest.length > 0) {
      const restResults = await processBatchWithShrink(client, rest, summariesDir, depth + 1);
      results.push(...restResults);
    }

    // Sort by page number
    results.sort((a, b) => a.pageNumber - b.pageNumber);
    return results;
  }
}

/**
 * Process pages in batches (GitHub providers)
 * @param {BaseLLMClient} client - LLM client
 * @param {Array} pagesToProcess - Pages to process
 * @param {string} summariesDir - Path to summaries directory
 * @returns {Promise<Array>} Page summaries
 */
async function processBatchPages(client, pagesToProcess, summariesDir) {
  const effectiveBudget = Math.floor(CONFIG.maxInputChars * CONFIG.safetyMargin);
  log('info', `🚀 Using adaptive batch processing (budget: ${effectiveBudget} chars)`);

  const batches = splitIntoBatches(pagesToProcess, CONFIG.maxInputChars);
  log(
    'info',
    `📦 Split into ${batches.length} batches (avg ${Math.ceil(pagesToProcess.length / batches.length)} pages/batch)`,
  );

  const results = [];
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    log(
      'info',
      `\n📦 Batch ${batchIdx + 1}/${batches.length}: pages [${batch[0].pageNumber}..${batch[batch.length - 1].pageNumber}] (${batch.length} pages)`,
    );

    const batchResults = await processBatchWithShrink(client, batch, summariesDir, 0);
    results.push(...batchResults);

    if (batchIdx < batches.length - 1) {
      log('debug', `Waiting ${CONFIG.requestDelayMs}ms before next batch...`);
      await sleep(CONFIG.requestDelayMs);
    }
  }
  return results;
}

export { processBatchPages, processBatchWithShrink };

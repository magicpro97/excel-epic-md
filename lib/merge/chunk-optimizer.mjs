import fs from 'fs';
import path from 'path';
import { MERGE_CONFIG } from '../config/config.mjs';
import { isHighCapacityClient } from '../llm-clients/client-factory.mjs';
import { GeminiClient } from '../llm-clients/gemini-client.mjs';
import { mergeSynthesisPrompt } from '../prompts/merge-prompt.mjs';
import { SYSTEM_INSTRUCTION } from '../prompts/system-instruction.mjs';
import { log } from '../utils/logger.mjs';

/**
 * Phase 2: Test chunk size to find optimal for this document
 * Uses binary-search-like approach with predefined test sizes
 * @param {BaseLLMClient} client - LLM client
 * @param {Array<object>} pageSummaries - All page summaries
 * @param {string} progressDir - Progress directory for caching
 * @returns {Promise<number>} Optimal chunk size
 */
async function findOptimalChunkSize(client, pageSummaries, progressDir) {
  // Check cache first
  const cacheFile = progressDir ? path.join(progressDir, MERGE_CONFIG.ADAPTIVE_CACHE_FILE) : null;
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      if (cached.optimalSize && cached.timestamp) {
        const age = Date.now() - cached.timestamp;
        if (age < 24 * 60 * 60 * 1000) {
          // Cache valid for 24 hours
          log(
            'info',
            `📋 Using cached optimal chunk size: ${cached.optimalSize} (from ${new Date(cached.timestamp).toLocaleString()})`,
          );
          return cached.optimalSize;
        }
      }
    } catch {
      log('debug', 'Could not load chunk size cache');
    }
  }

  // If not enough pages for testing, use default
  if (pageSummaries.length < MERGE_CONFIG.ADAPTIVE_TEST_PAGES) {
    log('info', `📋 Too few pages for adaptive chunking, using default: ${MERGE_CONFIG.HIGH_CAPACITY_CHUNK_SIZE}`);
    return MERGE_CONFIG.HIGH_CAPACITY_CHUNK_SIZE;
  }

  log('info', `🔬 Testing optimal chunk size with first ${MERGE_CONFIG.ADAPTIVE_TEST_PAGES} pages...`);

  // Test sizes in descending order (largest first)
  for (const testSize of MERGE_CONFIG.ADAPTIVE_TEST_CHUNK_SIZES) {
    if (testSize > pageSummaries.length) continue; // Skip if larger than total pages

    const testPages = pageSummaries.slice(0, Math.min(testSize, MERGE_CONFIG.ADAPTIVE_TEST_PAGES));

    try {
      log('info', `   Testing chunk size ${testSize} (${testPages.length} pages)...`);
      const prompt = mergeSynthesisPrompt(testPages);
      const startTime = Date.now();

      await client.generate(prompt, SYSTEM_INSTRUCTION, {
        estimatedOutputTokens: testSize * 2000, // ~2K tokens per page estimate
        pageCount: testSize,
      });

      const duration = Date.now() - startTime;
      log('info', `   ✅ Size ${testSize} succeeded in ${(duration / 1000).toFixed(1)}s`);

      // Cache successful result
      if (cacheFile) {
        fs.writeFileSync(
          cacheFile,
          JSON.stringify(
            {
              optimalSize: testSize,
              testedWith: testPages.length,
              duration,
              timestamp: Date.now(),
            },
            null,
            2,
          ),
        );
      }

      return testSize;
    } catch (err) {
      log('warn', `   ❌ Size ${testSize} failed: ${err.message.slice(0, 80)}`);
      continue; // Try next smaller size
    }
  }

  // All tests failed, use minimum safe size
  log('warn', `⚠️ All chunk size tests failed, falling back to minimum: ${MERGE_CONFIG.ADAPTIVE_MIN_CHUNK_SIZE}`);
  return MERGE_CONFIG.ADAPTIVE_MIN_CHUNK_SIZE;
}

/**
 * Determine chunk size based on client capacity
 * @param {BaseLLMClient} client - LLM client
 * @param {Array<object>} nonEmpty - Non-empty page summaries
 * @param {string|null} progressDir - Progress directory
 * @returns {Promise<{chunkSize: number, finalChunkSize: number, highCapacity: boolean}>} Chunk configuration
 */
async function determineChunkSizes(client, nonEmpty, progressDir) {
  const highCapacity = isHighCapacityClient(client);
  let chunkSize;

  if (highCapacity && client instanceof GeminiClient) {
    log('info', '🧪 Phase 2: Adaptive chunking enabled for Gemini');
    chunkSize = await findOptimalChunkSize(client, nonEmpty, progressDir);
    log('info', `📊 Using adaptive chunk size: ${chunkSize} pages`);
  } else {
    chunkSize = highCapacity ? MERGE_CONFIG.HIGH_CAPACITY_CHUNK_SIZE : MERGE_CONFIG.LOW_CAPACITY_CHUNK_SIZE;
    log('info', `📊 Using static chunk size: ${chunkSize} pages (${highCapacity ? 'high' : 'low'}-capacity mode)`);
  }

  const finalChunkSize = highCapacity
    ? MERGE_CONFIG.HIGH_CAPACITY_FINAL_CHUNK_SIZE
    : MERGE_CONFIG.LOW_CAPACITY_FINAL_CHUNK_SIZE;

  return { chunkSize, finalChunkSize, highCapacity };
}

export { determineChunkSizes, findOptimalChunkSize };

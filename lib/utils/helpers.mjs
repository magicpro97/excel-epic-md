/**
 * @module helpers
 * Shared utility functions for the synthesize pipeline:
 * sleep, batch splitting, retry detection, page cost estimation, CLI arg parsing.
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { CONFIG } from '../config/config.mjs';

/**
 * Sleep utility for async delays
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Estimate character cost for a page
 * @param {{ pageNumber: number, blocks: Array }} page - Page data
 * @returns {number} Estimated characters
 */
export function estimatePageCost(page) {
  if (!page.blocks || page.blocks.length === 0) return 100; // Empty page overhead
  const content = page.blocks.map((b) => `[${b.evidenceId}] ${b.text}`).join('\n');
  return content.length + 200; // +200 for formatting overhead
}

/**
 * Split pages into batches based on character budget
 * @param {Array} pages - Array of page data
 * @param {number} maxChars - Maximum characters per batch
 * @returns {Array<Array>} Array of batches
 */
export function splitIntoBatches(pages, maxChars) {
  const batches = [];
  let currentBatch = [];
  let currentChars = CONFIG.basePromptChars; // Start with prompt overhead
  const effectiveMax = Math.floor(maxChars * CONFIG.safetyMargin);

  for (const page of pages) {
    const pageCost = estimatePageCost(page);

    if (currentChars + pageCost > effectiveMax && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = CONFIG.basePromptChars;
    }

    currentBatch.push(page);
    currentChars += pageCost;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Check if error message indicates a retryable error
 * Shared utility for both LLM clients and standalone functions
 * @param {string} message - Error message to check
 * @returns {boolean} True if error is retryable
 */
export function isRetryableMessage(message) {
  if (!message) return false;
  return (
    message.includes('socket') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ECONNREFUSED') ||
    message.includes('fetch failed') ||
    message.includes('timeout') ||
    message.includes('TIMEOUT') ||
    message.includes('finish_reason: length') || // Response truncation - retryable
    message.includes('truncated') || // Generic truncation indicator
    message.includes('JSON parse') || // JSON parsing failures - retryable (model hallucination)
    message.includes('Failed to parse JSON') || // JSON parsing failures - retryable
    /\b5\d{2}\b/.test(message) // 5xx server errors
  );
}

/**
 * Extract the largest page from a batch (for shrink-on-error)
 * @param {Array} batch - Batch of pages
 * @returns {{ largest: object, rest: Array }} Largest page and remaining pages
 */
export function extractLargestPage(batch) {
  if (batch.length <= 1) {
    return { largest: batch[0], rest: [] };
  }

  let maxCost = 0;
  let maxIdx = 0;

  for (let i = 0; i < batch.length; i++) {
    const cost = estimatePageCost(batch[i]);
    if (cost > maxCost) {
      maxCost = cost;
      maxIdx = i;
    }
  }

  const largest = batch[maxIdx];
  const rest = [...batch.slice(0, maxIdx), ...batch.slice(maxIdx + 1)];
  return { largest, rest };
}

/**
 * Parse command line arguments using yargs
 * @returns {{ input: string | null, output: string | null, force: boolean }} Parsed arguments
 */
export function parseArgs() {
  const argv = yargs(hideBin(process.argv))
    .usage('Usage: $0 --output <outputDir> [--force] [--merge-only]')
    .option('input', {
      alias: 'i',
      type: 'string',
      description: 'Input directory (optional, defaults to output)',
    })
    .option('output', {
      alias: 'o',
      type: 'string',
      description: 'Output directory containing OCR results',
      demandOption: true,
    })
    .option('force', {
      alias: 'f',
      type: 'boolean',
      default: false,
      description: 'Force reprocessing (ignore page + chunk cache)',
    })
    .option('merge-only', {
      alias: 'm',
      type: 'boolean',
      default: false,
      description: 'Skip page processing, only run merge + assemble (requires cached page summaries)',
    })
    .help()
    .alias('help', 'h')
    .parseSync();

  return {
    input: argv.input || null,
    output: argv.output || null,
    force: argv.force,
    mergeOnly: argv.mergeOnly,
  };
}

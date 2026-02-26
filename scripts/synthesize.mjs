#!/usr/bin/env bun
/**
 * Synthesize epic requirement from OCR output using Gemini API
 *
 * Strategy: 2-pass synthesis
 * 1. Per-page extraction: Extract structured info from each page
 * 2. Merge synthesis: Combine all page summaries into epic requirement
 *
 * Output:
 * - llm/page_summaries/page-0001.json
 * - llm/epic_synthesis.json
 */

import fs from 'fs';
import { jaison } from 'jaison';
import { jsonrepair } from 'jsonrepair';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Get configuration from environment with defaults
 * @returns {object} Configuration object
 */
function getConfig() {
  return {
    // LLM limits (GitHub Models API has 8000 token hard limit per request)
    maxInputChars: parseInt(process.env.LLM_MAX_INPUT_CHARS || '24000'), // ~6000 tokens
    safetyMargin: parseFloat(process.env.LLM_SAFETY_MARGIN || '0.7'), // Pack to 70%
    basePromptChars: parseInt(process.env.LLM_BASE_PROMPT_CHARS || '4000'), // Prompt overhead

    // Rate limits
    rateLimitRpm: parseInt(process.env.LLM_RATE_LIMIT_RPM || '24'),
    rateLimitTpm: parseInt(process.env.LLM_RATE_LIMIT_TPM || '40000'),

    // Retry settings
    maxRetries: parseInt(process.env.LLM_MAX_RETRIES || '5'),
    retryDelayMs: parseInt(process.env.LLM_RETRY_DELAY_MS || '65000'),

    // Batch settings
    minBatchSize: 1,
    requestDelayMs: parseInt(process.env.LLM_REQUEST_DELAY_MS || '3000'),

    // Concurrency for parallel page processing
    pageConcurrency: parseInt(process.env.LLM_PAGE_CONCURRENCY || '5'),

    // Logging
    logLevel: process.env.LLM_LOG_LEVEL || 'info', // debug, info, warn, error
  };
}

const CONFIG = getConfig();

// Cache version - increment when prompt/extraction logic changes
// This ensures stale cache is invalidated when synthesis strategy changes
const CACHE_VERSION = '1.1.0'; // Bumped: added img2table data to page extraction prompt

// ============================================================================
// MERGE CONSTANTS (extracted from magic numbers for maintainability)
// ============================================================================

/**
 * Merge processing constants - adjust based on provider capabilities
 * @constant {object} MERGE_CONFIG
 */
const MERGE_CONFIG = {
  // Chunk sizes for hierarchical merge
  // Rationale: Each page averages ~2-3K tokens. With 20 pages × 3K = ~60K input tokens.
  // Output JSON is typically 1.5-2x input size. Safe margin for 65K output limit.
  // High-capacity (Gemini 1M context, 65K output): 20 pages/chunk
  // Low-capacity (GitHub 8K context): 10 pages/chunk
  HIGH_CAPACITY_CHUNK_SIZE: 20,
  LOW_CAPACITY_CHUNK_SIZE: 10,

  // Final merge chunk size (how many chunk results to merge at once)
  // Smaller than page chunks because chunk results contain structured JSON
  // High-capacity: 10 chunks, Low-capacity: 3 chunks
  HIGH_CAPACITY_FINAL_CHUNK_SIZE: 10,
  LOW_CAPACITY_FINAL_CHUNK_SIZE: 3,

  // Retry settings for merge operations
  CHUNK_MAX_RETRIES: 3,
  CHUNK_RETRY_DELAY_MS: 2000, // Base delay, multiplied by attempt number

  // OpenAI max tokens (128K context, safe output limit)
  OPENAI_MAX_OUTPUT_TOKENS: 8192,

  // Gemini output limits
  // Source: https://ai.google.dev/gemini-api/docs/models#gemini-2.0-flash
  // gemini-2.0-flash: 8192 output tokens
  // gemini-2.5-flash/pro: 65536 output tokens (8x increase)
  // Using env var to allow runtime override
  GEMINI_MAX_OUTPUT_TOKENS: (() => {
    const parsed = parseInt(process.env.LLM_GEMINI_MAX_OUTPUT_TOKENS || '65536', 10);
    return Number.isNaN(parsed) || parsed <= 0 ? 65536 : parsed;
  })(),

  // Rate limit handling
  RATE_LIMIT_EXTRA_WAIT_SECONDS: 5, // Extra buffer when waiting for rate limit reset
  RATE_LIMIT_DEFAULT_WAIT_SECONDS: 30, // Default wait if can't parse retry-after

  // Connection error retry
  CONNECTION_MAX_RETRIES: 5,
  CONNECTION_BASE_DELAY_MS: 2000, // Exponential backoff: delay * attempt

  // Model rotation delay (after switching models)
  MODEL_ROTATION_DELAY_MS: 1000,

  // ============ PHASE 1: TIMEOUT & STREAMING ============
  // Industry standard: 10 minutes timeout (Anthropic/OpenAI pattern)
  // Source: Anthropic SDK uses httpx.Timeout(timeout=10*60, connect=5.0)
  REQUEST_TIMEOUT_MS: 10 * 60 * 1000, // 10 minutes = 600,000ms
  CONNECT_TIMEOUT_MS: 30 * 1000, // 30 seconds for connection

  // Streaming thresholds (industry best practice)
  // Enable streaming for large requests to prevent idle timeout
  STREAMING_MIN_OUTPUT_TOKENS: 50000, // Enable streaming if expecting >50K tokens
  STREAMING_CHUNK_SIZE_PAGES: 15, // Use streaming for chunks with >15 pages

  // Retry pattern aligned with Anthropic SDK
  // Max 2 retries, exponential backoff: 0.5s → 1s → 2s → 4s → 8s (capped)
  ANTHROPIC_STYLE_MAX_RETRIES: 2,
  ANTHROPIC_BACKOFF_BASE_MS: 500, // 0.5 seconds base
  ANTHROPIC_BACKOFF_MAX_MS: 8000, // 8 seconds max

  // ============ PHASE 2: ADAPTIVE CHUNKING ============
  // Test chunk sizes at pipeline start to find optimal for this document
  ADAPTIVE_TEST_CHUNK_SIZES: [20, 15, 12, 10, 8], // Descending order
  ADAPTIVE_TEST_PAGES: 3, // Test with first N pages
  ADAPTIVE_CACHE_FILE: 'optimal_chunk_size.json', // Cache optimal size per document
  ADAPTIVE_MIN_CHUNK_SIZE: 5, // Minimum chunk size (safety limit)
  ADAPTIVE_MAX_CHUNK_SIZE: 25, // Maximum chunk size

  // Content limits for filtering and merging
  SUMMARY_MAX_LENGTH: 1000, // Max characters for final merged summary
  SUPER_CHUNK_SUMMARY_MAX_LENGTH: 500, // Max chars for super-chunk fallback summary
  MIN_TITLE_LENGTH: 5, // Minimum length for valid title (filters noise)
  MIN_QUESTION_LENGTH: 5, // Minimum length for valid open question
  MAX_OPEN_QUESTIONS: 30, // Maximum open questions to keep in final result
};

/**
 * Gemini free tier quotas - for estimation and warning
 * @constant {object} GEMINI_QUOTA
 */
const GEMINI_QUOTA = {
  // Free tier: 20 requests per day per model
  REQUESTS_PER_DAY_PER_MODEL: 20,
  // Available models for rotation
  DEFAULT_MODELS: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-pro'],
};

// ============================================================================
// LOGGING UTILITY
// ============================================================================

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

/** @type {import('fs').WriteStream|null} Log write stream for async logging */
let LOG_STREAM = null;

/**
 * Initialize file logging for debugging (async write stream)
 * @param {string} outputDir - Output directory for log file
 */
function initFileLogging(outputDir) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logFilePath = path.join(outputDir, `synthesize_${timestamp}.log`);
  LOG_STREAM = fs.createWriteStream(logFilePath, { flags: 'a' });

  // Handle stream errors gracefully
  LOG_STREAM.on('error', (err) => {
    console.error(`⚠️ Log file write error: ${err.message}`);
    LOG_STREAM = null; // Disable further logging to file
  });

  LOG_STREAM.write(`=== Synthesize Log Started at ${new Date().toISOString()} ===\n\n`);
  console.log(`📝 Log file: ${logFilePath}`);

  // Handle process signals for graceful shutdown
  const cleanup = async () => {
    await closeFileLogging();
    process.exit(0);
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
}

/**
 * Close log stream gracefully
 * @returns {Promise<void>}
 */
function closeFileLogging() {
  return new Promise((resolve) => {
    if (LOG_STREAM && !LOG_STREAM.destroyed) {
      LOG_STREAM.end(() => resolve());
      LOG_STREAM = null;
    } else {
      resolve();
    }
  });
}

/**
 * Append message to log file (async, non-blocking)
 * @param {string} message - Message to append
 */
function appendToLogFile(message) {
  if (LOG_STREAM && !LOG_STREAM.destroyed) {
    LOG_STREAM.write(message + '\n');
  }
}

/**
 * Log message with level and optional data
 * @param {'debug' | 'info' | 'warn' | 'error'} level - Log level
 * @param {string} message - Log message
 * @param {object} [data] - Optional structured data
 */
function log(level, message, data = null) {
  const currentLevel = LOG_LEVELS[CONFIG.logLevel] || 1;
  if (LOG_LEVELS[level] < currentLevel) return;

  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = { debug: '🔍', info: '📋', warn: '⚠️', error: '❌' }[level] || '•';

  let logLine;
  if (data) {
    logLine = `[${timestamp}] ${prefix} ${message} ${JSON.stringify(data, null, 2)}`;
    console.log(`[${timestamp}] ${prefix} ${message}`, JSON.stringify(data, null, 2));
  } else {
    logLine = `[${timestamp}] ${prefix} ${message}`;
    console.log(logLine);
  }

  // Also write to file
  appendToLogFile(logLine);
}

/**
 * Sleep utility for async delays
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// CACHE/RESUME UTILITIES
// ============================================================================

/**
 * Check if page is already cached
 * @param {string} summariesDir - Path to summaries directory
 * @param {number} pageNumber - Page number
 * @returns {{ cached: boolean, data: object | null }} Cache status
 */
function checkPageCache(summariesDir, pageNumber) {
  const summaryPath = path.join(summariesDir, `page-${String(pageNumber).padStart(4, '0')}.json`);
  if (fs.existsSync(summaryPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
      // Valid cache must have: pageNumber, not be an error, and matching cache version
      const versionMatch = data.cacheVersion === CACHE_VERSION;
      if (data.pageNumber === pageNumber && data.pageType !== 'error' && versionMatch) {
        return { cached: true, data };
      }
      if (!versionMatch && data.pageNumber === pageNumber) {
        log('debug', `Cache version mismatch for page ${pageNumber}: ${data.cacheVersion} !== ${CACHE_VERSION}`);
      }
    } catch {
      // Corrupted cache, will reprocess
    }
  }
  return { cached: false, data: null };
}

/**
 * Save page summary to cache
 * @param {string} summariesDir - Path to summaries directory
 * @param {number} pageNumber - Page number
 * @param {object} summary - Page summary data
 */
function savePageCache(summariesDir, pageNumber, summary) {
  const summaryPath = path.join(summariesDir, `page-${String(pageNumber).padStart(4, '0')}.json`);
  // Add cache version to summary for future validation
  const summaryWithVersion = { ...summary, cacheVersion: CACHE_VERSION };
  fs.writeFileSync(summaryPath, JSON.stringify(summaryWithVersion, null, 2));
}

// ============================================================================
// BATCH UTILITIES
// ============================================================================

/**
 * Estimate character cost for a page
 * @param {{ pageNumber: number, blocks: Array }} page - Page data
 * @returns {number} Estimated characters
 */
function estimatePageCost(page) {
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
function splitIntoBatches(pages, maxChars) {
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
function isRetryableMessage(message) {
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
function extractLargestPage(batch) {
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
function parseArgs() {
  const argv = yargs(hideBin(process.argv))
    .usage('Usage: $0 --output <outputDir> [--force]')
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
      description: 'Force reprocessing (ignore cache)',
    })
    .help()
    .alias('help', 'h')
    .parseSync();

  return {
    input: argv.input || null,
    output: argv.output || null,
    force: argv.force,
  };
}

/**
 * Base LLM Client interface with common utilities
 */
class BaseLLMClient {
  /**
   * Generate response from LLM
   * @param {string} prompt - User prompt
   * @param {string | null} _systemInstruction - System instruction (unused in base)
   * @returns {Promise<object>} Parsed JSON response
   */
  async generate(prompt, _systemInstruction = null) {
    throw new Error('Not implemented');
  }

  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if HTTP status is a server error (5xx - retryable)
   * @param {number} status - HTTP status code
   * @returns {boolean} True if server error
   */
  isServerError(status) {
    return status >= 500 && status < 600;
  }

  /**
   * Check if error is retryable (connection, timeout, or server error)
   * Uses shared isRetryableMessage() for consistency with standalone functions
   * @param {Error} err - Error object
   * @returns {boolean} True if retryable
   */
  isRetryableError(err) {
    return isRetryableMessage(err.message || '');
  }

  /**
   * Build chat messages array for OpenAI-compatible APIs
   * @param {string} prompt - User prompt
   * @param {string | null} systemInstruction - System instruction
   * @returns {Array<{role: string, content: string}>} Messages array
   */
  buildMessages(prompt, systemInstruction) {
    const messages = [];
    if (systemInstruction) {
      messages.push({ role: 'system', content: systemInstruction });
    }
    messages.push({ role: 'user', content: prompt });
    return messages;
  }

  /**
   * Strip reasoning model thinking tags from response.
   * DeepSeek R1 and similar models output <think>...</think> before actual response.
   * @param {string} text - Raw response text
   * @returns {string} Text with thinking tags removed
   * @private
   */
  stripThinkingTags(text) {
    const thinkEndTag = '</think>';
    const thinkEndIdx = text.indexOf(thinkEndTag);

    // Case 1: Complete thinking block - take content after </think>
    if (thinkEndIdx !== -1) {
      return text.slice(thinkEndIdx + thinkEndTag.length).trim();
    }

    // Case 2: Truncated thinking block (no </think>) - find first JSON char
    if (text.startsWith('<think>')) {
      const jsonStart = text.search(/[{[]/);
      if (jsonStart !== -1) {
        return text.slice(jsonStart);
      }
    }

    return text;
  }

  /**
   * Extract JSON from markdown code block.
   * @param {string} text - Text potentially containing ```json ... ```
   * @returns {object|null} Parsed JSON or null if not found
   * @private
   */
  extractJsonFromCodeBlock(text) {
    const startMarker = '```json';
    const endMarker = '```';
    const startIdx = text.indexOf(startMarker);

    if (startIdx === -1) {
      return null;
    }

    const contentStart = startIdx + startMarker.length;
    const endIdx = text.indexOf(endMarker, contentStart);

    if (endIdx === -1) {
      return null;
    }

    const jsonContent = text.slice(contentStart, endIdx).trim();
    const repaired = jsonrepair(jsonContent);
    return JSON.parse(repaired);
  }

  /**
   * Extract JSON object by matching braces (handles braces inside strings).
   * @param {string} text - Text containing JSON object
   * @returns {object|null} Parsed JSON or null if not found/invalid
   * @private
   */
  extractJsonByBraceMatching(text) {
    const jsonStart = text.indexOf('{');
    if (jsonStart === -1) {
      return null;
    }

    let depth = 0;
    let i = jsonStart;
    let inString = false;
    let escape = false;

    while (i < text.length) {
      const char = text[i];

      if (escape) {
        escape = false;
        i++;
        continue;
      }

      if (char === '\\' && inString) {
        escape = true;
        i++;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        i++;
        continue;
      }

      if (!inString) {
        if (char === '{') depth++;
        else if (char === '}') depth--;
        if (depth === 0) break;
      }

      i++;
    }

    // Incomplete JSON (unmatched braces)
    if (depth !== 0 || i >= text.length) {
      return null;
    }

    const jsonContent = text.slice(jsonStart, i + 1);
    const repaired = jsonrepair(jsonContent);
    return JSON.parse(repaired);
  }

  /**
   * Parse JSON from LLM response text.
   * Handles various response formats:
   * - Direct JSON
   * - JSON in markdown code blocks
   * - JSON with reasoning model thinking tags (<think>...</think>)
   * - JSON embedded in other text
   * Uses jsonrepair library for robust parsing of malformed JSON.
   * @param {string} text - Raw response text
   * @returns {object} Parsed JSON object
   * @throws {Error} If JSON cannot be extracted or parsed
   */
  parseJsonResponse(text) {
    // Step 1: Strip reasoning model thinking tags
    const cleanedText = this.stripThinkingTags(text);

    // Step 2: Try direct JSON parse
    try {
      return JSON.parse(cleanedText);
    } catch (directError) {
      log('debug', `   Direct parse failed: ${directError.message}`);
    }

    // Step 3: Try jaison (handles unescaped newlines, tabs, trailing commas, truncated JSON)
    try {
      const parsed = jaison(cleanedText);
      if (parsed !== null && typeof parsed === 'object') {
        log('info', `🔧 JSON parsed by jaison (LLM-tolerant parser)`);
        return parsed;
      }
    } catch (jaisonError) {
      log('debug', `   jaison failed: ${jaisonError.message}`);
    }

    // Step 4: Try markdown code block extraction
    try {
      const fromCodeBlock = this.extractJsonFromCodeBlock(cleanedText);
      if (fromCodeBlock !== null) {
        return fromCodeBlock;
      }
    } catch (codeBlockError) {
      log('debug', `   Code block extraction failed: ${codeBlockError.message}`);
    }

    // Step 5: Try jsonrepair (fallback for other malformed JSON patterns)
    try {
      const repaired = jsonrepair(cleanedText);
      const parsed = JSON.parse(repaired);
      log('info', `🔧 JSON repaired successfully by jsonrepair`);
      return parsed;
    } catch (repairError) {
      log('debug', `   jsonrepair failed: ${repairError.message}`);
    }

    // Step 6: Try brace matching extraction + jaison
    try {
      const extracted = this.extractJsonTextByBraceMatching(cleanedText);
      if (extracted) {
        const parsed = jaison(extracted);
        if (parsed !== null && typeof parsed === 'object') {
          log('info', `🔧 JSON parsed (brace extract + jaison)`);
          return parsed;
        }
      }
    } catch (braceError) {
      log('debug', `   Brace matching + jaison failed: ${braceError.message}`);
    }

    // All extraction methods failed
    const preview = cleanedText.substring(0, 200);
    throw new Error(`Failed to parse JSON from response: ${preview}`);
  }

  /**
   * Extract JSON text by brace matching (returns string, not parsed)
   * @param {string} text - Text containing JSON
   * @returns {string|null} Extracted JSON string or null
   * @private
   */
  extractJsonTextByBraceMatching(text) {
    const startIndex = text.indexOf('{');
    if (startIndex === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === '\\' && inString) {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') depth++;
        else if (char === '}') {
          depth--;
          if (depth === 0) {
            return text.slice(startIndex, i + 1);
          }
        }
      }
    }

    return null;
  }

  /**
   * Try to recover a truncated JSON object using jsonrepair library.
   * @param {string} text - Truncated JSON text
   * @returns {object|null} Recovered JSON object or null if recovery fails
   * @protected
   */
  tryRecoverTruncatedJson(text) {
    try {
      const repaired = jsonrepair(text);
      const result = JSON.parse(repaired);

      // Validate recovered JSON has meaningful content
      if (result === null || (typeof result === 'object' && Object.keys(result).length === 0)) {
        log('warn', `🔧 JSON recovery produced empty result, treating as failure`);
        return null;
      }

      log('info', `🔧 JSON recovery successful via jsonrepair`);
      return result;
    } catch (err) {
      log('debug', `🔧 JSON recovery failed: ${err.message}`);
      return null;
    }
  }
}

/**
 * Gemini API client with model rotation support for rate limit handling.
 *
 * Free tier limits:
 * - 20 requests/day per model
 * - Model rotation extends total quota (4 models = 80 requests/day)
 * @example
 * // Single model
 * const client = new GeminiClient(apiKey, 'gemini-2.5-flash');
 *
 * // Model rotation (recommended for free tier)
 * const client = new GeminiClient(apiKey, ['gemini-2.5-flash', 'gemini-2.0-flash']);
 */
class GeminiClient extends BaseLLMClient {
  /**
   * @param {string} apiKey - Gemini API key
   * @param {string|string[]} models - Single model or array for rotation
   */
  constructor(apiKey, models = 'gemini-1.5-pro') {
    super();
    this.apiKey = apiKey;
    this.models = Array.isArray(models) ? models : [models];
    this.currentModelIndex = 0;
    this.model = this.models[0];
    this.exhaustedModels = new Set(); // Track models that hit daily limit
    this.requestCount = 0; // Track requests for estimation
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';

    if (this.models.length > 1) {
      const totalQuota = this.models.length * GEMINI_QUOTA.REQUESTS_PER_DAY_PER_MODEL;
      log('info', `📡 Gemini model rotation enabled: ${this.models.join(' → ')}`);
      log(
        'info',
        `   Total daily quota: ~${totalQuota} requests (${GEMINI_QUOTA.REQUESTS_PER_DAY_PER_MODEL}/model × ${this.models.length} models)`,
      );
    }
  }

  /**
   * Get max tokens for output based on model
   * @returns {number} Max output tokens
   */
  getMaxTokens() {
    return MERGE_CONFIG.GEMINI_MAX_OUTPUT_TOKENS;
  }

  /**
   * Get remaining quota estimate
   * @returns {{ used: number, remaining: number, total: number }} Quota estimate
   */
  getQuotaEstimate() {
    const total = this.models.length * GEMINI_QUOTA.REQUESTS_PER_DAY_PER_MODEL;
    const exhaustedQuota = this.exhaustedModels.size * GEMINI_QUOTA.REQUESTS_PER_DAY_PER_MODEL;
    const remaining = Math.max(0, total - exhaustedQuota - this.requestCount);
    return { used: this.requestCount, remaining, total };
  }

  /**
   * Reset exhausted models (call at start of new session or after quota reset)
   */
  resetExhaustedModels() {
    this.exhaustedModels.clear();
    this.requestCount = 0;
    log('info', `🔄 Reset Gemini exhausted models. All ${this.models.length} models available.`);
  }

  /**
   * Try to rotate to next model when rate limited
   * @returns {boolean} True if rotation successful, false if all models exhausted
   */
  rotateModel() {
    // Mark current model as exhausted
    this.exhaustedModels.add(this.model);
    log('warn', `Model ${this.model} exhausted. Exhausted: ${this.exhaustedModels.size}/${this.models.length}`);

    // Find next non-exhausted model
    for (let i = 0; i < this.models.length; i++) {
      const nextIndex = (this.currentModelIndex + 1 + i) % this.models.length;
      const nextModel = this.models[nextIndex];

      if (!this.exhaustedModels.has(nextModel)) {
        this.currentModelIndex = nextIndex;
        this.model = nextModel;
        log('info', `🔄 Rotated to Gemini model: ${this.model}`);
        return true;
      }
    }

    log('error', `All ${this.models.length} Gemini models exhausted! Daily limits reached.`);
    return false;
  }

  /**
   * Check if error indicates daily rate limit
   * @param {object} errorJson - Error response JSON
   * @returns {boolean} True if daily limit exceeded
   */
  isDailyLimitError(errorJson) {
    const message = errorJson?.error?.message || '';
    return message.includes('limit: 0') || message.includes('per day') || message.includes('quota');
  }

  /**
   * Parse retry delay from error response
   * @param {object} errorJson - Error response JSON
   * @returns {number} Delay in seconds
   */
  parseRetryDelay(errorJson) {
    const message = errorJson?.error?.message || '';
    const match = message.match(/retry in (\d+(?:\.\d+)?)/i);
    if (match) {
      return Math.ceil(parseFloat(match[1])) + MERGE_CONFIG.RATE_LIMIT_EXTRA_WAIT_SECONDS;
    }
    return MERGE_CONFIG.RATE_LIMIT_DEFAULT_WAIT_SECONDS;
  }

  /**
   * Handle 429 rate limit from response object
   * @param {object} response - Fetch response object
   * @param {number} attempt - Current attempt number
   * @param {number} maxRetries - Max retry count
   * @returns {Promise<'retry'|'exhausted'|'wait'>} Action to take
   */
  async handleRateLimitResponse(response, attempt, maxRetries) {
    const errorJson = await response.json();

    // Check if it's a daily limit - need to rotate model
    if (this.isDailyLimitError(errorJson)) {
      if (this.rotateModel()) {
        await this.sleep(MERGE_CONFIG.MODEL_ROTATION_DELAY_MS);
        return 'retry';
      }
      return 'exhausted';
    }

    // Regular rate limit - wait and retry
    const retryDelay = this.parseRetryDelay(errorJson);
    if (attempt < maxRetries) {
      log('warn', `⏳ Gemini rate limit, waiting ${retryDelay}s (attempt ${attempt}/${maxRetries})...`);
      await this.sleep(retryDelay * 1000);
      return 'wait';
    }
    return 'exhausted';
  }

  /**
   * Build request body for Gemini API
   * @param {string} prompt - User prompt
   * @param {string | null} systemInstruction - System instruction
   * @returns {object} Request body
   */
  buildRequestBody(prompt, systemInstruction) {
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: this.getMaxTokens(),
        responseMimeType: 'application/json',
      },
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    return body;
  }

  /**
   * Phase 1: Determine if streaming should be used for this request
   * @param {number} estimatedOutputTokens - Expected output tokens
   * @param {number} pageCount - Number of pages in request
   * @returns {boolean} True if streaming should be enabled
   */
  shouldUseStreaming(estimatedOutputTokens, pageCount = 0) {
    // Enable streaming if:
    // 1. Expected output > 50K tokens (large responses)
    // 2. Processing > 15 pages (long-running operations)
    return (
      estimatedOutputTokens > MERGE_CONFIG.STREAMING_MIN_OUTPUT_TOKENS ||
      pageCount > MERGE_CONFIG.STREAMING_CHUNK_SIZE_PAGES
    );
  }

  /**
   * Phase 1: Create fetch signal with timeout
   * @returns {globalThis.AbortSignal} Abort signal with timeout
   */
  createTimeoutSignal() {
    return AbortSignal.timeout(MERGE_CONFIG.REQUEST_TIMEOUT_MS);
  }

  /**
   * Parse Gemini API response with truncation recovery
   * @param {object} data - Raw API response
   * @returns {object} Parsed JSON content
   * @throws {Error} If parsing fails and recovery is not possible
   * @private
   */
  parseGeminiResponse(data) {
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const finishReason = data.candidates?.[0]?.finishReason;

    // Log finish_reason for debugging truncation issues
    if (finishReason && finishReason !== 'STOP') {
      log('warn', `⚠️ Gemini response finishReason: ${finishReason} (expected: STOP)`);
    }

    if (!text) {
      throw new Error('Empty response from Gemini');
    }

    this.requestCount++;

    // Try to parse response, with recovery for truncated JSON
    try {
      return this.parseJsonResponse(text);
    } catch (parseError) {
      // Try to recover truncated JSON for 'MAX_TOKENS' or 'LENGTH' finish reasons
      if (finishReason === 'MAX_TOKENS' || finishReason === 'LENGTH' || finishReason === 'RECITATION') {
        const recovered = this.tryRecoverTruncatedJson(text);
        if (recovered) {
          log('warn', `🔧 Recovered truncated JSON (finishReason: ${finishReason}, partial data may be missing)`);
          return recovered;
        }
        throw new Error(
          `Response truncated (finishReason: ${finishReason}) - ${text?.length || 0} chars generated, JSON recovery failed`,
        );
      }

      // Enhanced error logging for debugging
      const textLength = text.length;
      const firstChars = text.substring(0, 100);
      const lastChars = text.substring(Math.max(0, textLength - 100));
      log('error', `❌ JSON parse failed. Length: ${textLength}, Finish reason: ${finishReason}`);
      log('error', `   First 100 chars: ${firstChars}`);
      log('error', `   Last 100 chars: ${lastChars}`);
      throw parseError;
    }
  }

  /**
   * Handle server errors with retry logic
   * @param {number} status - HTTP status code
   * @param {number} attempt - Current attempt number
   * @param {number} maxRetries - Maximum retries allowed
   * @returns {Promise<boolean>} True if should retry, false to throw
   * @private
   */
  async handleServerErrorWithRetry(status, attempt, maxRetries) {
    if (attempt < maxRetries) {
      const delay = MERGE_CONFIG.CONNECTION_BASE_DELAY_MS * attempt;
      log('warn', `⚠️ Gemini server error (${status}), retrying in ${delay}ms (${attempt}/${maxRetries})...`);
      await this.sleep(delay);
      return true;
    }
    return false;
  }

  /**
   * Phase 1 & 2: Generate response with 10-min timeout, streaming, and Anthropic-style retry
   * @param {string} prompt - User prompt
   * @param {string | null} systemInstruction - System instruction
   * @param {object} options - Generation options
   * @param {number} options.estimatedOutputTokens - Expected output size
   * @param {number} options.pageCount - Number of pages being processed
   * @returns {Promise<object>} Parsed JSON response
   */
  async generate(prompt, systemInstruction = null, options = {}) {
    const { estimatedOutputTokens = 0, pageCount = 0 } = options;
    const useStreaming = this.shouldUseStreaming(estimatedOutputTokens, pageCount);

    // Phase 2: Use Anthropic-style retry pattern (max 2 retries)
    const maxRetries = MERGE_CONFIG.ANTHROPIC_STYLE_MAX_RETRIES;
    const body = this.buildRequestBody(prompt, systemInstruction);

    if (useStreaming) {
      log('info', `🌊 Streaming enabled (${pageCount} pages, ~${estimatedOutputTokens} tokens expected)`);
      return await this.generateStreaming(body, maxRetries);
    }

    return await this.generateNonStreaming(body, maxRetries);
  }

  /**
   * Phase 1: Generate response without streaming (with 10-minute timeout)
   * @param {object} body - Request body
   * @param {number} maxRetries - Max retry attempts
   * @returns {Promise<object>} Parsed JSON response
   */
  async generateNonStreaming(body, maxRetries) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const url = `${this.baseUrl}/${this.model}:generateContent?key=${this.apiKey}`;

      try {
        // Phase 1: Add 10-minute timeout via AbortSignal
        const signal = this.createTimeoutSignal();

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal, // 10-minute timeout
        });

        // Handle rate limit (429)
        if (response.status === 429) {
          const action = await this.handleRateLimitResponse(response, attempt, maxRetries);
          if (action === 'retry' || action === 'wait') continue;

          // All models exhausted
          const quota = this.getQuotaEstimate();
          throw new Error(
            `All Gemini models exhausted (daily limits). ` +
              `Used: ${quota.used}/${quota.total} requests. ` +
              `Models tried: ${Array.from(this.exhaustedModels).join(', ')}. ` +
              `Quota resets at midnight UTC.`,
          );
        }

        // Handle server errors (5xx) - retry these
        if (this.isServerError(response.status)) {
          const shouldRetry = await this.handleServerErrorWithRetry(response.status, attempt, maxRetries);
          if (shouldRetry) continue;
          throw new Error(`Gemini server error after ${maxRetries} retries: ${response.status}`);
        }

        // Handle other errors (4xx except 429)
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Gemini API error: ${response.status} - ${errorText.slice(0, 200)}`);
        }

        // Success - parse response
        const data = await response.json();
        return this.parseGeminiResponse(data);
      } catch (err) {
        // Phase 2: Anthropic-style exponential backoff (0.5s → 1s → 2s → 4s → 8s max)
        if (attempt < maxRetries && this.isRetryableError(err)) {
          const backoffMs = Math.min(
            MERGE_CONFIG.ANTHROPIC_BACKOFF_BASE_MS * Math.pow(2, attempt),
            MERGE_CONFIG.ANTHROPIC_BACKOFF_MAX_MS,
          );
          log(
            'warn',
            `⚠️ Gemini error, retrying in ${backoffMs}ms (${attempt + 1}/${maxRetries}): ${err.message.slice(0, 80)}`,
          );
          await this.sleep(backoffMs);
          continue;
        }
        throw err;
      }
    }

    throw new Error(`Gemini generate failed after ${maxRetries + 1} attempts`);
  }

  /**
   * Handle streaming response status and decide action
   * @param {globalThis.Response} response - Fetch response
   * @param {number} attempt - Current attempt number
   * @param {number} maxRetries - Max retry attempts
   * @returns {Promise<'continue'|'ok'>} Action to take ('continue' to retry, 'ok' to proceed)
   * @throws {Error} When all retries exhausted or unrecoverable error
   */
  async handleStreamingStatus(response, attempt, maxRetries) {
    if (response.status === 429) {
      const action = await this.handleRateLimitResponse(response, attempt, maxRetries);
      if (action === 'retry' || action === 'wait') return 'continue';
      const quota = this.getQuotaEstimate();
      throw new Error(`All Gemini models exhausted. Used: ${quota.used}/${quota.total} requests.`);
    }

    if (this.isServerError(response.status)) {
      const shouldRetry = await this.handleServerErrorWithRetry(response.status, attempt, maxRetries);
      if (shouldRetry) return 'continue';
      throw new Error(`Gemini server error after ${maxRetries} retries: ${response.status}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini streaming error: ${response.status} - ${errorText.slice(0, 200)}`);
    }

    return 'ok';
  }

  /**
   * Parse SSE stream line and extract text/reason
   * @param {string} line - SSE line
   * @returns {{text?: string, reason?: string, done?: boolean}|null} Parsed chunk or null
   */
  parseSSELine(line) {
    if (!line.startsWith('data: ')) return null;
    const jsonStr = line.slice(6).trim();
    if (jsonStr === '[DONE]') return { done: true };

    try {
      const chunk = JSON.parse(jsonStr);
      return {
        text: chunk.candidates?.[0]?.content?.parts?.[0]?.text,
        reason: chunk.candidates?.[0]?.finishReason,
      };
    } catch {
      return null; // Skip malformed chunks
    }
  }

  /**
   * Read and accumulate SSE stream content
   * @param {globalThis.ReadableStreamDefaultReader} reader - Stream reader
   * @returns {Promise<{text: string, finishReason: string|null}>} Accumulated content
   */
  async accumulateSSEStream(reader) {
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedText = '';
    let finishReason = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const parsed = this.parseSSELine(line);
        if (!parsed) continue;
        if (parsed.done) break;
        if (parsed.text) accumulatedText += parsed.text;
        if (parsed.reason) finishReason = parsed.reason;
      }
    }

    return { text: accumulatedText, finishReason };
  }

  /**
   * Phase 1: Generate response with streaming (for large requests)
   * Streaming prevents idle timeout disconnections on long-running requests
   * @param {object} body - Request body
   * @param {number} maxRetries - Max retry attempts
   * @returns {Promise<object>} Parsed JSON response
   */
  async generateStreaming(body, maxRetries) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const url = `${this.baseUrl}/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

      try {
        const signal = this.createTimeoutSignal();
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });

        const statusAction = await this.handleStreamingStatus(response, attempt, maxRetries);
        if (statusAction === 'continue') continue;

        const { text, finishReason } = await this.accumulateSSEStream(response.body.getReader());
        const mockResponse = {
          candidates: [{ content: { parts: [{ text }] }, finishReason: finishReason || 'STOP' }],
        };

        return this.parseGeminiResponse(mockResponse);
      } catch (err) {
        if (attempt < maxRetries && this.isRetryableError(err)) {
          const backoffMs = Math.min(
            MERGE_CONFIG.ANTHROPIC_BACKOFF_BASE_MS * Math.pow(2, attempt),
            MERGE_CONFIG.ANTHROPIC_BACKOFF_MAX_MS,
          );
          log('warn', `⚠️ Streaming error, retrying in ${backoffMs}ms (${attempt + 1}/${maxRetries})`);
          await this.sleep(backoffMs);
          continue;
        }
        throw err;
      }
    }

    throw new Error(`Gemini streaming failed after ${maxRetries + 1} attempts`);
  }
}

/**
 * GitHub Models API client (uses Azure AI inference endpoint)
 * Models: gpt-4o, gpt-4o-mini, gpt-4.1, etc.
 *
 * Supports batch processing to handle rate limits efficiently.
 * Supports model rotation when daily limit (100/model/day) is hit.
 *
 * Rate limits for GitHub Models (free tier):
 * - 24 requests/minute
 * - 40,000 tokens/minute
 * - 100 requests/day per model (UserByModelByDay)
 */
class GitHubModelsClient extends BaseLLMClient {
  /**
   * @param {string} token - GitHub token with models scope
   * @param {string|string[]} models - Single model or array for rotation
   */
  constructor(token, models = 'gpt-4o') {
    super();
    this.token = token;
    // Support both single model (string) and rotation list (array)
    this.models = Array.isArray(models) ? models : [models];
    this.currentModelIndex = 0;
    this.model = this.models[0];
    this.exhaustedModels = new Set(); // Track models that hit daily limit
    this.baseUrl = 'https://models.inference.ai.azure.com';
    // Use CONFIG for limits
    this.maxInputChars = CONFIG.maxInputChars;
    this.maxInputTokens = Math.floor(this.maxInputChars / 4); // ~4 chars per token
    this.maxRetries = CONFIG.maxRetries;
    this.retryDelayMs = CONFIG.retryDelayMs;

    if (this.models.length > 1) {
      log('info', `Model rotation enabled: ${this.models.join(' → ')}`);
    }
  }

  /**
   * Get max tokens for output
   * @returns {number} Max output tokens
   */
  getMaxTokens() {
    // GitHub Models supports higher output for newer models
    if (this.model.includes('gpt-4o') || this.model.includes('gpt-4.1')) {
      return MERGE_CONFIG.OPENAI_MAX_OUTPUT_TOKENS * 2; // 16K
    }
    return MERGE_CONFIG.OPENAI_MAX_OUTPUT_TOKENS; // 8K default
  }

  /**
   * Reset exhausted models (call at start of new session or after quota reset)
   */
  resetExhaustedModels() {
    this.exhaustedModels.clear();
    log('info', `🔄 Reset GitHub Models exhausted models. All ${this.models.length} models available.`);
  }

  /**
   * Rotate to next available model in the list
   * @returns {boolean} True if rotated successfully, false if all exhausted
   */
  rotateToNextModel() {
    // Mark current model as exhausted
    this.exhaustedModels.add(this.model);
    log(
      'warn',
      `Model ${this.model} exhausted (daily limit). Exhausted: ${this.exhaustedModels.size}/${this.models.length}`,
    );

    // Find next non-exhausted model
    for (let i = 0; i < this.models.length; i++) {
      const nextIndex = (this.currentModelIndex + 1 + i) % this.models.length;
      const nextModel = this.models[nextIndex];

      if (!this.exhaustedModels.has(nextModel)) {
        this.currentModelIndex = nextIndex;
        this.model = nextModel;
        log('info', `⚡ Rotated to model: ${this.model} (${this.currentModelIndex + 1}/${this.models.length})`);
        return true;
      }
    }

    log('error', `All ${this.models.length} models exhausted! Daily limits reached.`);
    return false;
  }

  /**
   * Check if error indicates daily rate limit (UserByModelByDay)
   * @param {string} errorText - Error response text
   * @returns {boolean} True if daily limit exceeded
   */
  isDailyLimitError(errorText) {
    return (
      errorText.includes('UserByModelByDay') || errorText.includes('per 86400s exceeded') || errorText.includes('daily')
    );
  }

  /**
   * Estimate token count for text (rough: 1 token ≈ 4 chars for English/code)
   * For Japanese/Vietnamese, use 1 token ≈ 2 chars
   * @param {string} text - Text to estimate
   * @returns {number} Estimated tokens
   */
  estimateTokens(text) {
    // Mixed content: use ~2.5 chars per token as compromise
    return Math.ceil(text.length / 2.5);
  }

  /**
   * Estimate character count for text
   * @param {string} text - Text to estimate
   * @returns {number} Character count
   */
  estimateChars(text) {
    return text.length;
  }

  /**
   * Make API request and return response
   * @param {Array<{role: string, content: string}>} messages - Messages array
   * @returns {Promise<{ok: boolean, status: number, json: Function, text: Function}>} Fetch response
   */
  async makeApiRequest(messages) {
    return fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.2,
        max_tokens: this.getMaxTokens(),
        response_format: { type: 'json_object' },
      }),
    });
  }

  /**
   * Parse wait time from rate limit error
   * @param {string} errorText - Error response text
   * @returns {number} Wait time in milliseconds
   */
  parseWaitTime(errorText) {
    const waitMatch = errorText.match(/(?:wait|retry after|Retry-After:?)\s*(\d+)\s*(?:seconds?|s)/i);
    if (waitMatch) {
      const seconds = parseInt(waitMatch[1]);
      // Max reasonable wait time: 5 minutes (300s)
      const maxWaitSeconds = 300;
      if (seconds > 0 && seconds <= maxWaitSeconds) {
        return (seconds + MERGE_CONFIG.RATE_LIMIT_EXTRA_WAIT_SECONDS) * 1000;
      }
    }
    return this.retryDelayMs;
  }

  /**
   * Handle 429 rate limit from error text
   * @param {string} errorText - Error response text
   * @param {number} attempt - Current attempt number
   * @returns {Promise<'retry'|'wait'|'exhausted'>} Action: retry (model rotated), wait (delayed), exhausted (give up)
   */
  async handleRateLimitFromText(errorText, attempt) {
    // Check if this is a DAILY limit - need to rotate model
    if (this.isDailyLimitError(errorText)) {
      log('warn', `Daily limit hit for ${this.model}`);
      if (this.rotateToNextModel()) {
        await this.sleep(MERGE_CONFIG.MODEL_ROTATION_DELAY_MS * 3);
        return 'retry';
      }
      return 'exhausted';
    }

    // Regular rate limit - wait and continue retry loop
    const waitTime = this.parseWaitTime(errorText);
    if (attempt < this.maxRetries) {
      log(
        'info',
        `⏳ Rate limited (${this.model}), waiting ${Math.ceil(waitTime / 1000)}s before retry ${attempt + 1}/${this.maxRetries}...`,
      );
      await this.sleep(waitTime);
      return 'wait';
    }
    return 'exhausted';
  }

  /**
   * Generate with retry logic for rate limits
   * @param {string} prompt - User prompt
   * @param {string | null} systemInstruction - System instruction
   * @returns {Promise<object>} Parsed JSON response
   */
  async generate(prompt, systemInstruction = null) {
    const messages = this.buildMessages(prompt, systemInstruction);

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.makeApiRequest(messages);

        if (response.ok) {
          const data = await response.json();
          const text = data.choices?.[0]?.message?.content;
          if (!text) throw new Error('Empty response from GitHub Models');
          return this.parseJsonResponse(text);
        }

        const errorText = await response.text();

        if (response.status === 429) {
          const action = await this.handleRateLimitFromText(errorText, attempt);
          if (action === 'retry' || action === 'wait') continue;

          // All models exhausted
          throw new Error(
            `All GitHub Models exhausted (daily limits). Models tried: ${Array.from(this.exhaustedModels).join(', ')}`,
          );
        }

        // Handle server errors (5xx) - retry these
        if (this.isServerError(response.status)) {
          if (attempt < this.maxRetries) {
            const delay = MERGE_CONFIG.CONNECTION_BASE_DELAY_MS * attempt;
            log(
              'warn',
              `⚠️ GitHub Models server error (${response.status}), retrying in ${delay}ms (${attempt}/${this.maxRetries})...`,
            );
            await this.sleep(delay);
            continue;
          }
          throw new Error(`GitHub Models server error after ${this.maxRetries} retries: ${response.status}`);
        }

        throw new Error(`GitHub Models API error (${this.model}): ${response.status} - ${errorText}`);
      } catch (err) {
        // Retry on connection/timeout errors (using isRetryableError for unified logic)
        if (attempt < this.maxRetries && this.isRetryableError(err)) {
          const delay = MERGE_CONFIG.CONNECTION_BASE_DELAY_MS * attempt;
          log(
            'warn',
            `⚠️ GitHub Models connection error, retrying in ${delay}ms (${attempt}/${this.maxRetries}): ${err.message.slice(0, 50)}...`,
          );
          await this.sleep(delay);
          continue;
        }
        throw err;
      }
    }

    throw new Error(`GitHub Models generate failed after ${this.maxRetries} retries`);
  }

  /**
   * Process multiple pages in a single batch request
   * @param {Array<{pageNumber: number, blocks: Array}>} pages - Array of page data
   * @param {string} systemInstruction - System instruction
   * @param {Function} promptGenerator - Function to generate prompt for batch
   * @returns {Promise<Array<object>>} Array of results for each page
   */
  async generateBatch(pages, systemInstruction, promptGenerator) {
    const prompt = promptGenerator(pages);
    const result = await this.generate(prompt, systemInstruction);

    // Result should be { results: [...] } containing per-page results
    if (result.results && Array.isArray(result.results)) {
      return result.results;
    }

    // Fallback: return as single result
    return [result];
  }
}

/**
 * Azure OpenAI API client with enterprise SLA and stability
 *
 * Azure OpenAI provides:
 * - 99.9% SLA uptime guarantee
 * - Regional deployment options
 * - Enterprise security and compliance
 * - Same models as OpenAI with Azure hosting
 *
 * Environment variables:
 * - AZURE_OPENAI_ENDPOINT: Your Azure OpenAI endpoint (e.g., https://your-resource.openai.azure.com)
 * - AZURE_OPENAI_API_KEY: Your Azure OpenAI API key
 * - AZURE_OPENAI_DEPLOYMENT: Deployment name (e.g., gpt-4o)
 * - AZURE_OPENAI_API_VERSION: API version (default: 2024-02-15-preview)
 * @see https://learn.microsoft.com/en-us/azure/ai-services/openai/
 */
class AzureOpenAIClient extends BaseLLMClient {
  /**
   * @param {string} endpoint - Azure OpenAI endpoint URL
   * @param {string} apiKey - Azure OpenAI API key
   * @param {string} deployment - Deployment name
   * @param {string} apiVersion - API version
   */
  constructor(endpoint, apiKey, deployment, apiVersion = '2024-02-15-preview') {
    super();
    this.endpoint = endpoint.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = apiKey;
    this.deployment = deployment;
    this.apiVersion = apiVersion;
    this.model = deployment; // For compatibility with other clients
  }

  /**
   * Get max tokens based on deployment model
   * @returns {number} Max output tokens
   */
  getMaxTokens() {
    // GPT-4o supports up to 16K output tokens
    if (this.deployment.includes('gpt-4o') || this.deployment.includes('gpt-4-turbo')) {
      return MERGE_CONFIG.OPENAI_MAX_OUTPUT_TOKENS * 2; // 16K
    }
    return MERGE_CONFIG.OPENAI_MAX_OUTPUT_TOKENS; // 8K default
  }

  /**
   * Generate response with retry logic
   * @param {string} prompt - User prompt
   * @param {string | null} systemInstruction - System instruction
   * @returns {Promise<object>} Parsed JSON response
   */
  async generate(prompt, systemInstruction = null) {
    const messages = this.buildMessages(prompt, systemInstruction);
    const maxRetries = MERGE_CONFIG.CONNECTION_MAX_RETRIES;

    // Azure OpenAI endpoint format
    const url = `${this.endpoint}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': this.apiKey, // Azure uses api-key header instead of Authorization
          },
          body: JSON.stringify({
            messages,
            temperature: 0.2,
            max_tokens: this.getMaxTokens(),
            response_format: { type: 'json_object' },
          }),
        });

        // Handle rate limit (429)
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '30');
          const waitTime = (retryAfter + MERGE_CONFIG.RATE_LIMIT_EXTRA_WAIT_SECONDS) * 1000;

          if (attempt < maxRetries) {
            log('warn', `⏳ Azure OpenAI rate limit, waiting ${retryAfter}s (attempt ${attempt}/${maxRetries})...`);
            await this.sleep(waitTime);
            continue;
          }
          throw new Error(`Azure OpenAI rate limit exceeded after ${maxRetries} retries`);
        }

        // Handle server errors (5xx) - retry these
        if (this.isServerError(response.status)) {
          if (attempt < maxRetries) {
            const delay = MERGE_CONFIG.CONNECTION_BASE_DELAY_MS * attempt;
            log(
              'warn',
              `⚠️ Azure OpenAI server error (${response.status}), retrying in ${delay}ms (${attempt}/${maxRetries})...`,
            );
            await this.sleep(delay);
            continue;
          }
          throw new Error(`Azure OpenAI server error after ${maxRetries} retries: ${response.status}`);
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Azure OpenAI API error: ${response.status} - ${errorText.slice(0, 200)}`);
        }

        const data = await response.json();
        const text = data.choices?.[0]?.message?.content;

        if (!text) {
          throw new Error('Empty response from Azure OpenAI');
        }

        return this.parseJsonResponse(text);
      } catch (err) {
        // Retry on connection errors
        if (attempt < maxRetries && this.isRetryableError(err)) {
          const delay = MERGE_CONFIG.CONNECTION_BASE_DELAY_MS * attempt;
          log('warn', `⚠️ Azure OpenAI connection error, retrying in ${delay}ms (${attempt}/${maxRetries})...`);
          await this.sleep(delay);
          continue;
        }
        throw err;
      }
    }

    throw new Error(`Azure OpenAI generate failed after ${maxRetries} retries`);
  }
}

/**
 * OpenAI API client with retry logic and rate limit handling
 */
class OpenAIClient extends BaseLLMClient {
  /**
   * @param {string} apiKey - OpenAI API key
   * @param {string} model - Model identifier (e.g., 'gpt-4o', 'gpt-4o-mini')
   */
  constructor(apiKey, model = 'gpt-4o') {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = 'https://api.openai.com/v1';
  }

  /**
   * Get max tokens based on model type
   * @returns {number} Max output tokens
   */
  getMaxTokens() {
    // GPT-4o and GPT-4-turbo support up to 16K output
    if (this.model.includes('gpt-4o') || this.model.includes('gpt-4-turbo')) {
      return MERGE_CONFIG.OPENAI_MAX_OUTPUT_TOKENS * 2; // 16K
    }
    return MERGE_CONFIG.OPENAI_MAX_OUTPUT_TOKENS; // 8K default
  }

  /**
   * Generate response with retry logic
   * @param {string} prompt - User prompt
   * @param {string | null} systemInstruction - System instruction
   * @returns {Promise<object>} Parsed JSON response
   */
  async generate(prompt, systemInstruction = null) {
    const messages = this.buildMessages(prompt, systemInstruction);
    const maxRetries = MERGE_CONFIG.CONNECTION_MAX_RETRIES;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: 0.2,
            max_tokens: this.getMaxTokens(),
            response_format: { type: 'json_object' },
          }),
        });

        // Handle rate limit (429)
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '30');
          const waitTime = (retryAfter + MERGE_CONFIG.RATE_LIMIT_EXTRA_WAIT_SECONDS) * 1000;

          if (attempt < maxRetries) {
            log('warn', `⏳ OpenAI rate limit, waiting ${retryAfter}s (attempt ${attempt}/${maxRetries})...`);
            await this.sleep(waitTime);
            continue;
          }
          throw new Error(`OpenAI rate limit exceeded after ${maxRetries} retries`);
        }

        // Handle server errors (5xx) - retry these
        if (this.isServerError(response.status)) {
          if (attempt < maxRetries) {
            const delay = MERGE_CONFIG.CONNECTION_BASE_DELAY_MS * attempt;
            log(
              'warn',
              `⚠️ OpenAI server error (${response.status}), retrying in ${delay}ms (${attempt}/${maxRetries})...`,
            );
            await this.sleep(delay);
            continue;
          }
          throw new Error(`OpenAI server error after ${maxRetries} retries: ${response.status}`);
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`OpenAI API error: ${response.status} - ${errorText.slice(0, 200)}`);
        }

        const data = await response.json();
        const text = data.choices?.[0]?.message?.content;

        if (!text) {
          throw new Error('Empty response from OpenAI');
        }

        return this.parseJsonResponse(text);
      } catch (err) {
        // Retry on connection errors (using isRetryableError for unified logic)
        if (attempt < maxRetries && this.isRetryableError(err)) {
          const delay = MERGE_CONFIG.CONNECTION_BASE_DELAY_MS * attempt;
          log('warn', `⚠️ OpenAI connection error, retrying in ${delay}ms (${attempt}/${maxRetries})...`);
          await this.sleep(delay);
          continue;
        }
        throw err;
      }
    }

    throw new Error(`OpenAI generate failed after ${maxRetries} retries`);
  }
}

/**
 * OpenRouter API client - Unified access to multiple LLM providers
 *
 * Supports: Claude, GPT-4, Llama, Mistral, Gemini, and 100+ models
 * API is OpenAI-compatible with additional features.
 *
 * Rate limits vary by model. Free tier available for some models.
 * @see https://openrouter.ai/docs
 */
class OpenRouterClient extends BaseLLMClient {
  /**
   * @param {string} apiKey - OpenRouter API key
   * @param {string} model - Model identifier (e.g., 'anthropic/claude-3-opus', 'openai/gpt-4-turbo')
   */
  constructor(apiKey, model = 'anthropic/claude-3.5-sonnet') {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = 'https://openrouter.ai/api/v1';
    // Optional: Site info for OpenRouter analytics
    this.siteUrl = process.env.OPENROUTER_SITE_URL || '';
    this.siteName = process.env.OPENROUTER_SITE_NAME || 'excel-epic-md';
  }

  /**
   * Build request headers with optional site info
   * @returns {object} Headers object
   * @private
   */
  buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.siteUrl) {
      headers['HTTP-Referer'] = this.siteUrl;
    }
    if (this.siteName) {
      headers['X-Title'] = this.siteName;
    }
    return headers;
  }

  /**
   * Handle 429 rate limit response
   * @param {globalThis.Response} response - Fetch response
   * @param {number} attempt - Current attempt
   * @param {number} maxRetries - Max retries
   * @returns {Promise<{action: 'retry'|'throw', error?: Error}>} Action to take
   * @private
   */
  async handleRateLimit(response, attempt, maxRetries) {
    const errorJson = await response.json().catch(() => ({}));
    const retryAfter = parseInt(response.headers.get('retry-after') || '30');
    const waitTime = (retryAfter + MERGE_CONFIG.RATE_LIMIT_EXTRA_WAIT_SECONDS) * 1000;

    if (attempt < maxRetries) {
      log('warn', `⏳ OpenRouter rate limit, waiting ${retryAfter}s (attempt ${attempt}/${maxRetries})...`);
      await this.sleep(waitTime);
      return { action: 'retry' };
    }
    const message = errorJson?.error?.message || 'Too many requests';
    return { action: 'throw', error: new Error(`OpenRouter rate limit exceeded: ${message}`) };
  }

  /**
   * Handle 5xx server error response
   * @param {number} status - HTTP status code
   * @param {number} attempt - Current attempt
   * @param {number} maxRetries - Max retries
   * @returns {Promise<{action: 'retry'|'throw', error?: Error}>} Action to take
   * @private
   */
  async handleServerError(status, attempt, maxRetries) {
    if (attempt < maxRetries) {
      const delay = MERGE_CONFIG.CONNECTION_BASE_DELAY_MS * attempt;
      log('warn', `⚠️ OpenRouter server error (${status}), retrying in ${delay}ms (${attempt}/${maxRetries})...`);
      await this.sleep(delay);
      return { action: 'retry' };
    }
    return { action: 'throw', error: new Error(`OpenRouter server error after ${maxRetries} retries: ${status}`) };
  }

  /**
   * Parse and validate API response
   * @param {object} data - API response data
   * @returns {object} Parsed JSON content
   * @throws {Error} If response is empty or invalid
   * @private
   */
  parseApiResponse(data) {
    const text = data.choices?.[0]?.message?.content;
    const finishReason = data.choices?.[0]?.finish_reason;

    // Log finish_reason for debugging truncation issues
    if (finishReason !== 'stop') {
      log('warn', `⚠️ OpenRouter response finish_reason: ${finishReason} (expected: stop)`);
    }

    if (!text) {
      throw new Error('Empty response from OpenRouter');
    }

    try {
      return this.parseJsonResponse(text);
    } catch (parseError) {
      // Try to recover truncated JSON for 'length' finish_reason
      if (finishReason === 'length') {
        const recovered = this.tryRecoverTruncatedJson(text);
        if (recovered) {
          log('warn', `🔧 Recovered truncated JSON (partial data may be missing)`);
          return recovered;
        }
        // Recovery failed - throw retryable error to trigger retry with smaller chunks
        throw new Error(
          `Response truncated (finish_reason: length) - ${text?.length || 0} chars generated, JSON recovery failed`,
        );
      }

      // Enhanced error logging for debugging
      const textLength = text.length;
      const firstChars = text.substring(0, 100);
      const lastChars = text.substring(Math.max(0, textLength - 100));
      log('error', `❌ JSON parse failed. Length: ${textLength}, Finish reason: ${finishReason}`);
      log('error', `   First 100 chars: ${firstChars}`);
      log('error', `   Last 100 chars: ${lastChars}`);
      throw parseError;
    }
  }

  // Note: countUnclosedStructures() and tryRecoverTruncatedJson() are inherited from BaseLLMClient

  /**
   * Generate response with retry logic
   * @param {string} prompt - User prompt
   * @param {string | null} systemInstruction - System instruction
   * @returns {Promise<object>} Parsed JSON response
   */
  async generate(prompt, systemInstruction = null) {
    const messages = this.buildMessages(prompt, systemInstruction);
    const headers = this.buildHeaders();
    const maxRetries = MERGE_CONFIG.CONNECTION_MAX_RETRIES;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Use NODE_TLS_REJECT_UNAUTHORIZED=0 workaround for corporate proxy SSL inspection
        // The proxy intercepts HTTPS and presents its own cert which Node.js doesn't trust
        const fetchOptions = {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: 0.2,
            max_tokens: this.getMaxTokens(),
            response_format: { type: 'json_object' },
          }),
        };

        // Temporarily disable TLS verification for corporate proxy
        const origTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        if (process.env.HTTPS_PROXY || process.env.https_proxy) {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        }
        let response;
        try {
          response = await fetch(`${this.baseUrl}/chat/completions`, fetchOptions);
        } finally {
          // Restore original TLS setting
          if (origTls !== undefined) {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTls;
          } else {
            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
          }
        }

        // Handle rate limit (429)
        if (response.status === 429) {
          const result = await this.handleRateLimit(response, attempt, maxRetries);
          if (result.action === 'retry') continue;
          throw result.error;
        }

        // Handle server errors (5xx)
        if (this.isServerError(response.status)) {
          const result = await this.handleServerError(response.status, attempt, maxRetries);
          if (result.action === 'retry') continue;
          throw result.error;
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`OpenRouter API error: ${response.status} - ${errorText.slice(0, 200)}`);
        }

        const data = await response.json();
        return this.parseApiResponse(data);
      } catch (err) {
        // Retry on connection errors
        if (attempt < maxRetries && this.isRetryableError(err)) {
          const delay = MERGE_CONFIG.CONNECTION_BASE_DELAY_MS * attempt;
          log('warn', `⚠️ OpenRouter connection error, retrying in ${delay}ms (${attempt}/${maxRetries})...`);
          await this.sleep(delay);
          continue;
        }
        throw err;
      }
    }

    throw new Error(`OpenRouter generate failed after ${maxRetries} retries`);
  }

  /**
   * Get max tokens based on model type
   * @returns {number} Max output tokens
   */
  getMaxTokens() {
    // Use merge-specific max tokens (configurable via env)
    const mergeLimit = MERGE_CONFIG.MERGE_MAX_OUTPUT_TOKENS;

    // Claude models support larger outputs (up to 64K)
    if (this.model.includes('claude')) {
      return Math.min(mergeLimit, 65536);
    }
    // Mistral Devstral has 32K documented, but may be lower on free tier
    if (this.model.includes('devstral') || this.model.includes('mistral')) {
      return Math.min(mergeLimit, 32768);
    }
    // DeepSeek models support large outputs
    if (this.model.includes('deepseek')) {
      return Math.min(mergeLimit, 65536);
    }
    // Llama 3.3 70B has 8K max output
    if (this.model.includes('llama')) {
      return MERGE_CONFIG.OPENAI_MAX_OUTPUT_TOKENS; // 8K
    }
    // GPT models
    if (this.model.includes('gpt')) {
      return MERGE_CONFIG.OPENAI_MAX_OUTPUT_TOKENS; // 8K
    }
    // Default for other models - use merge limit
    return Math.min(mergeLimit, MERGE_CONFIG.GEMINI_MAX_OUTPUT_TOKENS);
  }
}

/**
 * Ollama client (local LLM) with retry logic
 */
class OllamaClient extends BaseLLMClient {
  /**
   * @param {string} host - Ollama host URL
   * @param {string} model - Model name (e.g., 'llama3.2', 'mistral')
   */
  constructor(host = 'http://localhost:11434', model = 'llama3.2') {
    super();
    this.host = host;
    this.model = model;
  }

  /**
   * Get max tokens for output (Ollama uses num_predict)
   * @returns {number} Max output tokens
   */
  getMaxTokens() {
    return MERGE_CONFIG.OPENAI_MAX_OUTPUT_TOKENS;
  }

  /**
   * Generate response with retry logic
   * @param {string} prompt - User prompt
   * @param {string | null} systemInstruction - System instruction
   * @returns {Promise<object>} Parsed JSON response
   */
  async generate(prompt, systemInstruction = null) {
    const fullPrompt = systemInstruction ? `${systemInstruction}\n\n${prompt}` : prompt;
    const maxRetries = MERGE_CONFIG.CONNECTION_MAX_RETRIES;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.host}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            prompt: fullPrompt,
            stream: false,
            format: 'json',
            options: {
              temperature: 0.2,
              num_predict: this.getMaxTokens(),
            },
          }),
        });

        // Handle rate limit (429) - Ollama can return this when overloaded
        if (response.status === 429) {
          if (attempt < maxRetries) {
            const delay = MERGE_CONFIG.RATE_LIMIT_DEFAULT_WAIT_SECONDS * 1000;
            log(
              'warn',
              `⏳ Ollama rate limited, waiting ${MERGE_CONFIG.RATE_LIMIT_DEFAULT_WAIT_SECONDS}s (attempt ${attempt}/${maxRetries})...`,
            );
            await this.sleep(delay);
            continue;
          }
          throw new Error(`Ollama rate limit exceeded after ${maxRetries} retries`);
        }

        // Handle server errors (5xx) - retry these (Ollama may be overloaded)
        if (this.isServerError(response.status)) {
          if (attempt < maxRetries) {
            const delay = MERGE_CONFIG.CONNECTION_BASE_DELAY_MS * attempt;
            log(
              'warn',
              `⚠️ Ollama server error (${response.status}), retrying in ${delay}ms (${attempt}/${maxRetries})...`,
            );
            await this.sleep(delay);
            continue;
          }
          throw new Error(`Ollama server error after ${maxRetries} retries: ${response.status}`);
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Ollama API error: ${response.status} - ${errorText.slice(0, 200)}`);
        }

        const data = await response.json();
        const text = data.response;

        if (!text) {
          throw new Error('Empty response from Ollama');
        }

        return this.parseJsonResponse(text);
      } catch (err) {
        // Retry on connection/timeout errors (Ollama server may be starting)
        if (attempt < maxRetries && this.isRetryableError(err)) {
          const delay = MERGE_CONFIG.CONNECTION_BASE_DELAY_MS * attempt;
          log('warn', `⚠️ Ollama connection error, retrying in ${delay}ms (${attempt}/${maxRetries})...`);
          await this.sleep(delay);
          continue;
        }
        throw err;
      }
    }

    throw new Error(`Ollama generate failed after ${maxRetries} retries`);
  }
}

/**
 * Create LLM client based on environment configuration
 * @returns {BaseLLMClient} Configured LLM client
 */
function createLLMClient() {
  const provider = process.env.LLM_PROVIDER || 'gemini';

  switch (provider.toLowerCase()) {
    case 'gemini': {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY not set in environment');
      }
      const model = process.env.GEMINI_MODEL || 'gemini-1.5-pro';
      log('info', `📡 Using Gemini (${model})`);
      return new GeminiClient(apiKey, model);
    }

    case 'github': {
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error('GITHUB_TOKEN not set (needs "models" scope)');
      }
      // Support model rotation via GITHUB_MODELS (comma-separated)
      const modelsEnv = process.env.GITHUB_MODELS;
      const models = modelsEnv
        ? modelsEnv
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean)
        : [process.env.GITHUB_MODEL || 'gpt-4o'];

      if (models.length > 1) {
        log('info', `📡 Using GitHub Models with rotation: ${models[0]} (+${models.length - 1} fallbacks)`);
      } else {
        log('info', `📡 Using GitHub Models (${models[0]})`);
      }
      return new GitHubModelsClient(token, models);
    }

    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY not set in environment');
      }
      const model = process.env.OPENAI_MODEL || 'gpt-4o';
      log('info', `📡 Using OpenAI (${model})`);
      return new OpenAIClient(apiKey, model);
    }

    case 'ollama': {
      const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
      const model = process.env.OLLAMA_MODEL || 'llama3.2';
      log('info', `📡 Using Ollama local (${model})`);
      return new OllamaClient(host, model);
    }

    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY not set in environment');
      }
      const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet';
      log('info', `📡 Using OpenRouter (${model})`);
      return new OpenRouterClient(apiKey, model);
    }

    case 'azure': {
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
      const apiKey = process.env.AZURE_OPENAI_API_KEY;
      const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
      const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview';

      if (!endpoint) {
        throw new Error('AZURE_OPENAI_ENDPOINT not set (e.g., https://your-resource.openai.azure.com)');
      }
      if (!apiKey) {
        throw new Error('AZURE_OPENAI_API_KEY not set in environment');
      }
      if (!deployment) {
        throw new Error('AZURE_OPENAI_DEPLOYMENT not set (e.g., gpt-4o)');
      }

      log('info', `📡 Using Azure OpenAI (${deployment}) - Enterprise SLA`);
      return new AzureOpenAIClient(endpoint, apiKey, deployment, apiVersion);
    }

    default:
      throw new Error(`Unknown LLM provider: ${provider}. Valid: gemini, github, openai, azure, ollama, openrouter`);
  }
}

/**
 * Create separate LLM client for merge step (higher token limits)
 * Uses LLM_MERGE_PROVIDER if set, otherwise returns null (use main client)
 * @returns {{ client: BaseLLMClient | null, provider: string | null, model: string | null }} Merge client info
 */
function createMergeClient() {
  const mergeProvider = process.env.LLM_MERGE_PROVIDER;

  // If no merge provider specified, use main client
  if (!mergeProvider) {
    return { client: null, provider: null, model: null };
  }

  switch (mergeProvider.toLowerCase()) {
    case 'gemini': {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        log('warn', 'GEMINI_API_KEY not set, falling back to main provider for merge');
        return { client: null, provider: null, model: null };
      }
      // Support model rotation for merge (each model has 20 req/day limit)
      const modelsStr = process.env.GEMINI_MERGE_MODELS;
      const models = modelsStr ? modelsStr.split(',').map((m) => m.trim()) : null;
      const model = models || process.env.LLM_MERGE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      const displayModel = Array.isArray(model) ? model[0] : model;
      log('info', `📡 Merge client: Gemini (${displayModel}) - 1M token context`);
      return { client: new GeminiClient(apiKey, model), provider: 'gemini', model: displayModel };
    }

    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        log('warn', 'OPENAI_API_KEY not set, falling back to main provider for merge');
        return { client: null, provider: null, model: null };
      }
      const model = process.env.LLM_MERGE_MODEL || process.env.OPENAI_MODEL || 'gpt-4o';
      log('info', `📡 Merge client: OpenAI (${model}) - 128K token context`);
      return { client: new OpenAIClient(apiKey, model), provider: 'openai', model };
    }

    case 'github': {
      // Not recommended for merge (8K limit), but allow if explicitly set
      log('warn', 'GitHub Models has 8K token limit, may fail on large merges');
      return { client: null, provider: null, model: null };
    }

    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        log('warn', 'OPENROUTER_API_KEY not set, falling back to main provider for merge');
        return { client: null, provider: null, model: null };
      }
      const model = process.env.LLM_MERGE_MODEL || process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet';
      const contextSize = model.includes('claude') ? '200K' : '128K';
      log('info', `📡 Merge client: OpenRouter (${model}) - ${contextSize} token context`);
      return { client: new OpenRouterClient(apiKey, model), provider: 'openrouter', model };
    }

    case 'azure': {
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
      const apiKey = process.env.AZURE_OPENAI_API_KEY;
      const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
      const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview';

      if (!endpoint || !apiKey || !deployment) {
        log('warn', 'Azure OpenAI not configured, falling back to main provider for merge');
        return { client: null, provider: null, model: null };
      }

      const mergeDeployment = process.env.LLM_MERGE_MODEL || deployment;
      log('info', `📡 Merge client: Azure OpenAI (${mergeDeployment}) - Enterprise SLA, 128K token context`);
      return {
        client: new AzureOpenAIClient(endpoint, apiKey, mergeDeployment, apiVersion),
        provider: 'azure',
        model: mergeDeployment,
      };
    }

    default:
      log('warn', `Unknown LLM_MERGE_PROVIDER: ${mergeProvider}, using main provider`);
      return { client: null, provider: null, model: null };
  }
}

/**
 * Check if client is high-capacity (Gemini, OpenAI non-mini, Azure, OpenRouter)
 * @param {BaseLLMClient} client - LLM client
 * @returns {boolean} True if high capacity
 */
function isHighCapacityClient(client) {
  return (
    client instanceof GeminiClient ||
    client instanceof OpenRouterClient ||
    client instanceof AzureOpenAIClient ||
    (client instanceof OpenAIClient && !client.model.includes('mini'))
  );
}

// Prompts
const SYSTEM_INSTRUCTION = `Bạn là Business Analyst chuyên nghiệp, phân tích tài liệu yêu cầu phần mềm.

NGUYÊN TẮC BẮT BUỘC:
1. Mỗi thông tin PHẢI có Evidence ID [EV-XXXX-bXXXX] trích dẫn từ nguồn (ví dụ: [EV-s01-b0001] hoặc [EV-p0001-b0001])
2. KHÔNG được suy luận hoặc thêm thông tin không có trong tài liệu
3. Nếu thiếu thông tin, ghi rõ "N/A" và liệt kê trong Open Questions
4. Output bằng tiếng Việt, NGOẠI TRỪ các thuật ngữ UI (xem rule 5) và bảng (xem rule 7)
5. QUAN TRỌNG - Giữ nguyên thuật ngữ tiếng Nhật gốc cho các yếu tố UI:
   - Tên màn hình, tên nút, tên trường, label, menu item
   - Format: "日本語原文 (Bản dịch tiếng Việt)"
   - Ví dụ: "傷病者一覧 (Danh sách bệnh nhân)", "現在地へ (Đến vị trí hiện tại)"
   - Mục đích: Dễ dàng mapping với UI thực tế khi implement
6. Format JSON theo schema yêu cầu
7. QUAN TRỌNG - Giữ nguyên cấu trúc BẢNG trong tài liệu (SONG NGỮ):
   - Khi phát hiện bảng (table), PHẢI giữ nguyên format bảng markdown
   - Header bảng: Giữ tiếng Nhật gốc + dịch tiếng Việt trong ngoặc
     Ví dụ: "列名 (Tên cột)" | "入力チェック (Kiểm tra đầu vào)"
   - Nội dung cell: Giữ tiếng Nhật gốc + dịch tiếng Việt trong ngoặc
     Ví dụ: "そのまま出力 (Xuất nguyên trạng)" | "エラーとする (Báo lỗi)"
   - KHÔNG được chuyển bảng thành văn bản mô tả (narrative text)
   - Ví dụ bảng cần giữ: TSV specification, field mapping, error check rules, import/export format
   - Với bảng phức tạp có merged cells, tách thành nhiều bảng con nếu cần để hiển thị đúng trong markdown`;

/**
 * Generate page extraction prompt
 * @param {number} pageNumber - Page number
 * @param {Array<{evidenceId: string, text: string, isAmbiguous: boolean}>} blocks - OCR blocks
 * @param {Array<object>} [tables] - Detected tables from img2table (defaults to empty array)
 * @returns {string} Prompt for Gemini API
 */
const pageExtractionPrompt = (pageNumber, blocks, tables = []) => `
Phân tích nội dung OCR từ trang ${pageNumber} của tài liệu yêu cầu.

## OCR Blocks (Evidence Source)
${blocks.map((b) => `- [${b.evidenceId}] ${b.text}${b.isAmbiguous ? ' ⚠️ (confidence < 0.7)' : ''}`).join('\n')}
${
  tables.length > 0
    ? `
## Detected Tables (img2table)
Dưới đây là các bảng được phát hiện tự động từ hình ảnh. Sử dụng dữ liệu này để reconstruct bảng spec chính xác.
${tables
  .map((t) => {
    const header = t.content[0] || [];
    const dataRows = t.content.slice(1);
    const headerRow = `| ${header.join(' | ')} |`;
    const separatorRow = `| ${header.map(() => '---').join(' | ')} |`;
    const dataRowsStr = dataRows.map((r) => `| ${r.join(' | ')} |`).join('\n');
    const md = `${headerRow}\n${separatorRow}\n${dataRowsStr}`;
    return `### Table [${t.evidenceId}] (${t.rows}x${t.cols})\n${md}`;
  })
  .join('\n\n')}
`
    : ''
}

## Yêu cầu
Trích xuất thông tin có cấu trúc từ nội dung trên.

## Output Schema (JSON)
{
  "pageNumber": ${pageNumber},
  "pageType": "cover|overview|requirement|detail|appendix|other",
  "extractedInfo": {
    "title": "string hoặc null - tiêu đề nếu có [EV-XXXX-bXXXX]",
    "context": "string hoặc null - bối cảnh/background [EV-XXXX-bXXXX]",
    "requirements": [
      {
        "id": "REQ-001",
        "description": "mô tả yêu cầu [EV-XXXX-bXXXX]",
        "priority": "high|medium|low|unknown",
        "evidenceIds": ["EV-XXXX-bXXXX"]
      }
    ],
    "tasks": [
      {
        "description": "mô tả công việc [EV-XXXX-bXXXX]",
        "evidenceIds": ["EV-XXXX-bXXXX"]
      }
    ],
    "notes": ["ghi chú quan trọng [EV-XXXX-bXXXX]"],
    "figures": ["mô tả hình/biểu đồ nếu có [EV-XXXX-bXXXX]"],
    "tables": [
      {
        "title": "tên/mô tả bảng [EV-XXXX-bXXXX]",
        "markdownTable": "| Header1 | Header2 |\\n|---|---|\\n| data | data |",
        "evidenceIds": ["EV-XXXX-bXXXX"],
        "notes": "ghi chú về bảng nếu có"
      }
    ]
  },
  "ambiguousTexts": [
    {
      "evidenceId": "EV-XXXX-bXXXX",
      "text": "nội dung không rõ",
      "issue": "mô tả vấn đề"
    }
  ],
  "openQuestions": ["câu hỏi cần làm rõ"]
}

QUAN TRỌNG: 
- Mỗi thông tin PHẢI kèm Evidence ID. Không có Evidence = không ghi.
- BẢNG: Khi phát hiện bảng trong tài liệu, PHẢI giữ nguyên cấu trúc markdown table trong field "tables".
  Header và nội dung cell phải SONG NGỮ: giữ tiếng Nhật gốc + dịch tiếng Việt trong ngoặc.
  Ví dụ: "列名 (Tên cột)" | "そのまま出力 (Xuất nguyên trạng)"
  KHÔNG chuyển bảng thành text mô tả.
`;

/**
 * Generate batch extraction prompt for multiple pages
 * @param {Array<{pageNumber: number, blocks: Array<{evidenceId: string, text: string, isAmbiguous: boolean}>}>} pages - Array of page data
 * @returns {string} Prompt for batch processing
 */
const batchExtractionPrompt = (pages) => `
Phân tích nội dung OCR từ ${pages.length} trang của tài liệu yêu cầu.

## Input: OCR Data từ ${pages.length} trang

${pages
  .map(
    (p) => `
### TRANG ${p.pageNumber}
${
  p.blocks.length === 0
    ? '(Trang trống - không có text)'
    : p.blocks.map((b) => `- [${b.evidenceId}] ${b.text}${b.isAmbiguous ? ' ⚠️ (confidence < 0.7)' : ''}`).join('\n')
}
`,
  )
  .join('\n---\n')}

## Yêu cầu
Trích xuất thông tin có cấu trúc từ MỖI trang.

## Output Schema (JSON)
{
  "results": [
    {
      "pageNumber": <số trang>,
      "pageType": "cover|overview|requirement|detail|appendix|empty|other",
      "extractedInfo": {
        "title": "string hoặc null - tiêu đề nếu có [EV-XXXX-bXXXX]",
        "context": "string hoặc null - bối cảnh/background [EV-XXXX-bXXXX]",
        "requirements": [
          {
            "id": "REQ-001",
            "description": "mô tả yêu cầu [EV-XXXX-bXXXX]",
            "priority": "high|medium|low|unknown",
            "evidenceIds": ["EV-XXXX-bXXXX"]
          }
        ],
        "tasks": [
          {
            "description": "mô tả công việc [EV-XXXX-bXXXX]",
            "evidenceIds": ["EV-XXXX-bXXXX"]
          }
        ],
        "notes": ["ghi chú quan trọng [EV-XXXX-bXXXX]"],
        "figures": ["mô tả hình/biểu đồ nếu có [EV-XXXX-bXXXX]"],
        "tables": [
          {
            "title": "tên/mô tả bảng [EV-XXXX-bXXXX]",
            "markdownTable": "| Header1 | Header2 |\\n|---|---|\\n| data | data |",
            "evidenceIds": ["EV-XXXX-bXXXX"],
            "notes": "ghi chú về bảng nếu có"
          }
        ]
      },
      "ambiguousTexts": [],
      "openQuestions": []
    }
    // ... một object cho mỗi trang trong input
  ]
}

QUAN TRỌNG: 
1. Output PHẢI có đúng ${pages.length} phần tử trong mảng "results"
2. Mỗi phần tử tương ứng với 1 trang, theo thứ tự trong input
3. Nếu trang trống, dùng pageType: "empty" và extractedInfo: {}
4. Mỗi thông tin PHẢI kèm Evidence ID từ OCR blocks
5. BẢNG: Khi phát hiện bảng, PHẢI giữ cấu trúc markdown table trong field "tables".
   Header và nội dung cell phải SONG NGỮ: giữ tiếng Nhật gốc + dịch tiếng Việt trong ngoặc.
   Ví dụ: "更新範囲 (Phạm vi cập nhật)" | "確認結果 (Kết quả xác nhận)"
`;

/**
 * Generate merge synthesis prompt
 * @param {Array<object>} pageSummaries - Array of page summary objects
 * @returns {string} Prompt for Gemini API
 */
const mergeSynthesisPrompt = (pageSummaries) => `
Tổng hợp thông tin từ tất cả các trang thành tài liệu Epic Requirement hoàn chỉnh, dễ đọc, dễ hiểu.

## Page Summaries
${JSON.stringify(pageSummaries, null, 2)}

## Yêu cầu Output
Tạo tài liệu Epic Requirement với các đặc điểm:
- **KHÔNG sử dụng Evidence IDs** (loại bỏ hoàn toàn [EV-XXXX-bXXXX])
- Nội dung chi tiết, đầy đủ ý nghĩa
- Câu cú rõ ràng, mạch lạc, dễ đọc
- Ghép nối thông tin logic, không rời rạc
- **GIỮ NGUYÊN các bảng dưới dạng markdown table** (không chuyển thành văn bản)

## Output Schema (JSON)
{
  "epic": {
    "title": "Tiêu đề Epic rõ ràng, súc tích",
    "summary": "Tóm tắt 2-3 câu nêu bật mục đích và phạm vi chính"
  },
  "context": {
    "background": "Bối cảnh dự án/tính năng - viết thành đoạn văn mạch lạc",
    "objectives": ["Mục tiêu 1 - diễn đạt đầy đủ", "Mục tiêu 2 - diễn đạt đầy đủ"],
    "scope": "Phạm vi công việc - mô tả rõ ràng những gì bao gồm và không bao gồm"
  },
  "requirements": [
    {
      "id": "REQ-001",
      "category": "functional|non-functional|constraint",
      "description": "Mô tả chi tiết yêu cầu - viết thành câu hoàn chỉnh, dễ hiểu",
      "priority": "high|medium|low"
    }
  ],
  "tasks": [
    {
      "id": "TASK-001",
      "description": "Mô tả công việc cụ thể cần thực hiện",
      "relatedRequirements": ["REQ-001"]
    }
  ],
  "acceptanceCriteria": [
    "Tiêu chí nghiệm thu - viết rõ ràng, có thể kiểm chứng được"
  ],
  "assumptions": [
    "Giả định - nêu rõ điều kiện tiên quyết"
  ],
  "openQuestions": [
    {
      "question": "Câu hỏi cần làm rõ",
      "context": "Lý do cần hỏi và ảnh hưởng nếu không giải quyết"
    }
  ],
  "tables": [
    {
      "title": "Tên bảng (giữ nguyên tiếng Nhật nếu có)",
      "markdownTable": "| Header1 | Header2 |\\n|---|---|\\n| data | data |",
      "notes": "Ghi chú về bảng"
    }
  ],
  "appendix": {
    "figures": ["Mô tả hình minh họa quan trọng"],
    "references": ["Tài liệu tham chiếu liên quan"]
  }
}

NGUYÊN TẮC VIẾT:
1. KHÔNG dùng Evidence IDs - loại bỏ hoàn toàn các ký hiệu [EV-...]
2. Gộp các yêu cầu trùng lặp thành một mô tả đầy đủ
3. Viết câu hoàn chỉnh, có chủ ngữ - vị ngữ rõ ràng
4. Sắp xếp requirements theo priority (high → medium → low)
5. Thông tin mâu thuẫn → đưa vào Open Questions
6. Nếu thiếu thông tin → ghi "Cần bổ sung thêm thông tin"
7. QUAN TRỌNG: Giữ nguyên các bảng (specification table, mapping table, error check table)
   dưới dạng markdown table trong field "tables". KHÔNG được chuyển bảng thành văn bản mô tả.
   Header và nội dung cell phải SONG NGỮ: giữ tiếng Nhật gốc + dịch tiếng Việt trong ngoặc.
   Ví dụ: "更新範囲 (Phạm vi cập nhật)" | "そのまま出力 (Xuất nguyên trạng)" | "エラーとする (Báo lỗi)"
`;

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
 * Process a single page with OCR data
 * @param {GeminiClient} client - Gemini API client
 * @param {number} pageNumber - Page number
 * @param {{ blocks: Array<object>, tables?: Array<object> }} ocrData - OCR data for the page
 * @returns {Promise<object>} Extracted page information
 */
async function processPage(client, pageNumber, ocrData) {
  log('debug', `🧠 Analyzing page ${pageNumber}...`);

  if (!ocrData.blocks || ocrData.blocks.length === 0) {
    log('debug', `⚠️  Page ${pageNumber} has no text blocks`);
    return {
      pageNumber,
      pageType: 'empty',
      extractedInfo: {},
      ambiguousTexts: [],
      openQuestions: [],
    };
  }

  const tables = ocrData.tables || [];
  if (tables.length > 0) {
    log('info', `📊 Page ${pageNumber}: ${tables.length} table(s) detected by img2table`);
  }

  const prompt = pageExtractionPrompt(pageNumber, ocrData.blocks, tables);

  // Phase 3 Fix: Use generateWithFallback for per-page processing
  // This provides OpenRouter fallback when Gemini socket disconnects
  // Estimate ~1000 output tokens per page (conservative)
  const options = {
    estimatedOutputTokens: 1000,
    pageCount: 1,
  };

  const { result, usedFallback } = await generateWithFallback(client, prompt, SYSTEM_INSTRUCTION, options);

  if (usedFallback) {
    log('info', `🔄 Page ${pageNumber} processed via OpenRouter fallback`);
  }

  return result;
}

// ============================================================================
// MERGE SYNTHESIS HELPER FUNCTIONS
// ============================================================================

/**
 * Extract best title from chunk results, filtering noise
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
 * Phase 3: Create OpenRouter client for fallback
 * @returns {OpenRouterClient | null} OpenRouter client or null if not configured
 */
function createOpenRouterFallbackClient() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    log('warn', 'OpenRouter fallback not available (OPENROUTER_API_KEY not set)');
    return null;
  }

  const model = process.env.OPENROUTER_MODEL || 'mistralai/mistral-large';
  log('info', `🌐 OpenRouter fallback configured with model: ${model}`);
  return new OpenRouterClient(apiKey, model);
}

/**
 * Phase 3: Generate with OpenRouter fallback
 * Falls back to OpenRouter after 2 Gemini failures
 * @param {BaseLLMClient} primaryClient - Primary LLM client (Gemini)
 * @param {string} prompt - User prompt
 * @param {string | null} systemInstruction - System instruction
 * @param {object} options - Generation options
 * @returns {Promise<{result: object, usedFallback: boolean}>} Result and fallback flag
 */
async function generateWithFallback(primaryClient, prompt, systemInstruction = null, options = {}) {
  const MAX_PRIMARY_ATTEMPTS = 3;
  let lastError = null;

  // Try primary client first (Gemini with retries)
  for (let attempt = 1; attempt <= MAX_PRIMARY_ATTEMPTS; attempt++) {
    try {
      const result = await primaryClient.generate(prompt, systemInstruction, options);
      return { result, usedFallback: false };
    } catch (err) {
      lastError = err;

      // Check if it's a quota exhaustion - don't retry, go straight to fallback
      if (err.message.includes('exhausted') || err.message.includes('quota')) {
        log('warn', `⚠️ Gemini quota exhausted, switching to OpenRouter fallback`);
        break;
      }

      // Retry on retryable errors
      if (attempt < MAX_PRIMARY_ATTEMPTS && isRetryableMessage(err.message)) {
        const backoffMs = Math.min(
          MERGE_CONFIG.ANTHROPIC_BACKOFF_BASE_MS * Math.pow(2, attempt),
          MERGE_CONFIG.ANTHROPIC_BACKOFF_MAX_MS,
        );
        log(
          'warn',
          `⚠️ Primary client attempt ${attempt}/${MAX_PRIMARY_ATTEMPTS} failed, retrying in ${backoffMs}ms...`,
        );
        await sleep(backoffMs);
        continue;
      }

      // Non-retryable error or max attempts reached
      log('warn', `⚠️ Primary client failed: ${err.message.slice(0, 100)}`);
      break;
    }
  }

  // Primary client failed, try OpenRouter fallback
  log('info', '🔄 Phase 3: Attempting OpenRouter fallback...');

  try {
    const openRouterClient = createOpenRouterFallbackClient();
    if (!openRouterClient) {
      throw new Error('OpenRouter fallback not configured (missing API key)');
    }

    const result = await openRouterClient.generate(prompt, systemInstruction, options);
    log('info', '✅ OpenRouter fallback succeeded');
    return { result, usedFallback: true };
  } catch (fallbackErr) {
    log('error', `❌ OpenRouter fallback also failed: ${fallbackErr.message.slice(0, 100)}`);
    // Throw the original error from primary client
    throw lastError || new Error('Both primary and fallback clients failed');
  }
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

/**
 * Load cached chunk results if available
 * @param {string|null} chunkResultsFile - Path to chunk results file
 * @param {number} expectedChunks - Expected number of chunks
 * @returns {{chunkResults: Array, startIndex: number}} Cached results and start index
 */
function loadCachedChunkResults(chunkResultsFile, expectedChunks) {
  if (!chunkResultsFile || !fs.existsSync(chunkResultsFile)) {
    return { chunkResults: [], startIndex: 0 };
  }

  try {
    const cached = JSON.parse(fs.readFileSync(chunkResultsFile, 'utf-8'));
    if (cached.chunks && cached.totalChunks === expectedChunks) {
      log('info', `📦 Resuming merge: ${cached.chunks.length}/${expectedChunks} chunks already processed`);
      return { chunkResults: cached.chunks, startIndex: cached.chunks.length };
    }
  } catch {
    log('warn', 'Could not load chunk cache, starting fresh');
  }
  return { chunkResults: [], startIndex: 0 };
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
    const finalPrompt = createFinalMergePrompt(chunkResults);
    const { result } = await generateWithFallback(client, finalPrompt, SYSTEM_INSTRUCTION, {
      estimatedOutputTokens: chunkResults.length * 5000,
      pageCount: 0,
    });
    return result;
  }

  // Hierarchical final merge
  log('info', `📊 Many chunks (${chunkResults.length}), using hierarchical final merge...`);
  const superChunkResults = await processSuperChunks(client, chunkResults, finalChunkSize);

  if (superChunkResults.length > finalChunkSize) {
    log('info', `📊 Still many super-chunks (${superChunkResults.length}), using smart direct merge...`);
    return createDirectMergeResult(superChunkResults);
  }

  log('info', `🔗 Final merge of ${superChunkResults.length} super-chunk results...`);
  const finalPrompt = createFinalMergePrompt(superChunkResults);
  const { result: finalResult } = await generateWithFallback(client, finalPrompt, SYSTEM_INSTRUCTION, {
    estimatedOutputTokens: superChunkResults.length * 5000,
    pageCount: 0,
  });

  return finalResult;
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

/**
 * Create prompt for final merge of chunk results
 * @param {Array<object>} chunkResults - Array of chunk synthesis results
 * @returns {string} Final merge prompt
 */
function createFinalMergePrompt(chunkResults) {
  return `
Tổng hợp kết quả từ ${chunkResults.length} chunk thành tài liệu Epic Requirement hoàn chỉnh, dễ đọc, chuyên nghiệp.

## Chunk Results
${JSON.stringify(chunkResults, null, 2)}

## Yêu cầu Output
Tạo tài liệu Epic Requirement tổng hợp cuối cùng với các đặc điểm:
- **LOẠI BỎ HOÀN TOÀN Evidence IDs** - không dùng bất kỳ ký hiệu [EV-...] nào
- Gộp nội dung từ các chunks thành văn bản liền mạch
- Câu cú rõ ràng, cấu trúc mạch lạc, dễ hiểu
- Mỗi requirement/task là một mô tả đầy đủ, không rời rạc

## Output Schema (JSON)
{
  "epic": {
    "title": "Tiêu đề Epic rõ ràng, phản ánh nội dung chính",
    "summary": "Tóm tắt 2-3 câu về mục đích và phạm vi của epic"
  },
  "context": {
    "background": "Bối cảnh dự án - viết thành đoạn văn mạch lạc, giải thích lý do và hoàn cảnh",
    "objectives": ["Mục tiêu cụ thể, đo lường được"],
    "scope": "Phạm vi rõ ràng - bao gồm và không bao gồm những gì"
  },
  "requirements": [
    {
      "id": "REQ-001",
      "category": "functional|non-functional|constraint",
      "description": "Mô tả chi tiết yêu cầu bằng câu hoàn chỉnh, dễ hiểu",
      "priority": "high|medium|low"
    }
  ],
  "tasks": [
    {
      "id": "TASK-001",
      "description": "Mô tả công việc cần thực hiện - cụ thể, rõ ràng",
      "relatedRequirements": ["REQ-001"]
    }
  ],
  "acceptanceCriteria": ["Tiêu chí nghiệm thu cụ thể, có thể kiểm chứng"],
  "assumptions": ["Giả định và điều kiện tiên quyết"],
  "openQuestions": [
    {
      "question": "Câu hỏi cần làm rõ",
      "context": "Lý do cần hỏi và tác động nếu không giải quyết"
    }
  ],
  "appendix": {
    "figures": ["Mô tả hình minh họa quan trọng"],
    "references": ["Tài liệu tham chiếu"]
  }
}

NGUYÊN TẮC:
1. KHÔNG sử dụng Evidence IDs - loại bỏ hoàn toàn mọi [EV-XXXX-bXXXX]
2. Gộp requirements trùng lặp thành mô tả đầy đủ, súc tích
3. Viết câu hoàn chỉnh với chủ ngữ - vị ngữ rõ ràng
4. Sắp xếp requirements theo priority (high → medium → low)
5. Gộp tasks theo thứ tự logic thực hiện
6. Nội dung phải đọc được như một tài liệu chuyên nghiệp
`;
}

// ============================================================================
// Validation Layer - Evidence Cross-Reference & Completeness
// ============================================================================

/**
 * Collect all evidence IDs from OCR data
 * @param {Array<{pageNumber: number, blocks: Array, tables?: Array}>} allPages - All OCR pages
 * @returns {Set<string>} Set of all evidence IDs from OCR
 */
function collectOcrEvidenceIds(allPages) {
  const evidenceIds = new Set();

  for (const page of allPages) {
    // Collect block evidence IDs
    for (const block of page.blocks || []) {
      if (block.evidenceId) {
        evidenceIds.add(block.evidenceId);
      }
    }
    // Collect table evidence IDs (from img2table)
    for (const table of page.tables || []) {
      if (table.evidenceId) {
        evidenceIds.add(table.evidenceId);
      }
    }
  }

  return evidenceIds;
}

/**
 * Extract evidence IDs referenced in LLM output
 * Pattern: EV-pNNNN-bMMMM, EV-pNNNN-tMMMM, EV-sNN-bMMMM, EV-sNN-tMMMM
 * @param {object} synthesis - LLM synthesis output
 * @returns {Set<string>} Set of evidence IDs found in output
 */
function extractEvidenceFromOutput(synthesis) {
  const evidenceIds = new Set();
  const evidencePattern = /EV-[ps]\d{2,4}-[bt]\d{4}/g;

  /**
   * Recursively search for evidence IDs in any value
   * @param {any} value - Value to search
   */
  function searchValue(value) {
    if (typeof value === 'string') {
      const matches = value.match(evidencePattern);
      if (matches) {
        matches.forEach((id) => evidenceIds.add(id));
      }
    } else if (Array.isArray(value)) {
      value.forEach(searchValue);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(searchValue);
    }
  }

  searchValue(synthesis);
  return evidenceIds;
}

/**
 * Calculate completeness metrics
 * @param {Set<string>} ocrEvidence - All evidence IDs from OCR
 * @param {Set<string>} usedEvidence - Evidence IDs used by LLM
 * @returns {{ usedCount: number, totalCount: number, percentage: number, unusedIds: string[] }} Completeness metrics with usage count, total count, percentage coverage, and list of unused evidence IDs
 */
function calculateCompleteness(ocrEvidence, usedEvidence) {
  const totalCount = ocrEvidence.size;
  const usedCount = [...usedEvidence].filter((id) => ocrEvidence.has(id)).length;
  const percentage = totalCount > 0 ? Math.round((usedCount / totalCount) * 100) : 0;

  // Find unused evidence IDs
  const unusedIds = [...ocrEvidence].filter((id) => !usedEvidence.has(id));

  return {
    usedCount,
    totalCount,
    percentage,
    unusedIds,
  };
}

/**
 * Validate evidence IDs - check for hallucinated references
 * @param {Set<string>} ocrEvidence - All evidence IDs from OCR
 * @param {Set<string>} usedEvidence - Evidence IDs used by LLM
 * @returns {{ valid: boolean, hallucinated: string[] }} Validation result with validity flag and list of hallucinated evidence IDs
 */
function validateEvidenceReferences(ocrEvidence, usedEvidence) {
  const hallucinated = [...usedEvidence].filter((id) => !ocrEvidence.has(id));

  return {
    valid: hallucinated.length === 0,
    hallucinated,
  };
}

/**
 * Generate validation flags for output
 * @param {{ valid: boolean, hallucinated: string[] }} referenceValidation - Reference validation result
 * @param {{ usedCount: number, totalCount: number, percentage: number }} completeness - Completeness metrics
 * @returns {Array<{ level: 'error' | 'warning' | 'info', message: string }>} Validation flags with severity level and message
 */
function generateValidationFlags(referenceValidation, completeness) {
  const flags = [];

  // Error: Hallucinated evidence IDs
  if (!referenceValidation.valid) {
    flags.push({
      level: 'error',
      message: `Hallucinated evidence IDs detected: ${referenceValidation.hallucinated.join(', ')}`,
    });
  }

  // Warning: Low completeness
  if (completeness.percentage < 50) {
    flags.push({
      level: 'warning',
      message: `Low OCR coverage: Only ${completeness.percentage}% of evidence used (${completeness.usedCount}/${completeness.totalCount})`,
    });
  } else if (completeness.percentage < 70) {
    flags.push({
      level: 'info',
      message: `OCR coverage: ${completeness.percentage}% (${completeness.usedCount}/${completeness.totalCount})`,
    });
  }

  return flags;
}

/**
 * Comprehensive validation of synthesis output
 * @param {object} synthesis - Epic synthesis result
 * @param {Array<{pageNumber: number, blocks: Array, tables?: Array}>} [allPages] - OCR pages for cross-reference
 * @returns {{ issues: string[], flags: Array<object>, completeness: object | null, referenceValidation: object | null }} Validation results including issues, flags, completeness metrics, and reference validation
 */
function validateEvidence(synthesis, allPages = null) {
  const issues = [];
  let completeness = null;
  let referenceValidation = null;
  let flags = [];

  // Basic structure validation
  if (!synthesis.epic?.title) {
    issues.push('Missing epic title');
  }

  if (!synthesis.requirements || synthesis.requirements.length === 0) {
    issues.push('No requirements extracted');
  }

  // Cross-reference validation (if OCR data provided)
  if (allPages && allPages.length > 0) {
    const ocrEvidence = collectOcrEvidenceIds(allPages);
    const usedEvidence = extractEvidenceFromOutput(synthesis);

    // Validate references
    referenceValidation = validateEvidenceReferences(ocrEvidence, usedEvidence);

    // Calculate completeness
    completeness = calculateCompleteness(ocrEvidence, usedEvidence);

    // Generate flags
    flags = generateValidationFlags(referenceValidation, completeness);

    // Add hallucination errors to issues
    if (!referenceValidation.valid) {
      issues.push(`Found ${referenceValidation.hallucinated.length} hallucinated evidence ID(s)`);
    }

    log(
      'info',
      `Validation: ${completeness.percentage}% OCR coverage, ${referenceValidation.hallucinated.length} hallucinated refs`,
    );
  }

  return {
    issues,
    flags,
    completeness,
    referenceValidation,
  };
}

/**
 * Load all OCR files from directory
 * @param {string} ocrDir - Path to OCR directory
 * @returns {Array<{pageNumber: number, blocks: Array, ocrFile: string}>} Array of page data
 */
function loadOcrFiles(ocrDir) {
  // Prefer sheet-based OCR files over page-based
  let ocrFiles = fs
    .readdirSync(ocrDir)
    .filter((f) => f.match(/^sheet-\d+\.json$/))
    .sort();

  let mode = 'sheet';

  if (ocrFiles.length === 0) {
    ocrFiles = fs
      .readdirSync(ocrDir)
      .filter((f) => f.match(/^page-\d+\.json$/))
      .sort();
    mode = 'page';
  }

  if (ocrFiles.length === 0) {
    throw new Error(`No OCR files found in ${ocrDir}`);
  }

  log('info', `Found ${ocrFiles.length} ${mode}s to synthesize`);

    return ocrFiles.map((ocrFile) => {
    const ocrPath = path.join(ocrDir, ocrFile);
    const ocrData = JSON.parse(fs.readFileSync(ocrPath, 'utf-8'));

    // Normalize blocks: ensure evidenceId exists (backward compat with older OCR)
    const blocks = (ocrData.blocks || []).map((b, idx) => {
      const pagePrefix = mode === 'sheet'
        ? `s${String(ocrData.page).padStart(2, '0')}`
        : `p${String(ocrData.page).padStart(4, '0')}`;
      const blockId = String(b.id || idx + 1).padStart(4, '0');
      const defaultEvidenceId = `EV-${pagePrefix}-b${blockId}`;

      return {
        ...b,
        evidenceId: b.evidenceId || defaultEvidenceId,
      };
    });

    return {
      pageNumber: ocrData.page,
      sheetName: ocrData.sheetName || null,
      blocks,
      tables: ocrData.tables || [],
      ocrFile,
    };
  });
}

/**
 * Check cache and split pages to process
 * @param {Array} allPages - All pages from OCR
 * @param {string} summariesDir - Path to summaries cache directory
 * @param {boolean} force - Force reprocess flag
 * @returns {{ pageSummaries: Array, pagesToProcess: Array, cachedCount: number }} Processed result
 */
function preparePageCache(allPages, summariesDir, force) {
  const pageSummaries = [];
  const pagesToProcess = [];
  let cachedCount = 0;

  for (const page of allPages) {
    const cache = checkPageCache(summariesDir, page.pageNumber);
    if (cache.cached && !force) {
      pageSummaries.push(cache.data);
      cachedCount++;
    } else {
      pagesToProcess.push(page);
    }
  }

  if (cachedCount > 0) {
    log('info', `📦 Resuming: ${cachedCount} pages cached, ${pagesToProcess.length} pages to process`);
  }

  return { pageSummaries, pagesToProcess, cachedCount };
}

/**
 * Process pages using batch method (GitHub Models)
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

/**
 * Process pages individually (non-GitHub providers)
 * @param {BaseLLMClient} client - LLM client
 * @param {Array} pagesToProcess - Pages to process
 * @param {string} ocrDir - Path to OCR directory
 * @param {string} summariesDir - Path to summaries directory
 * @returns {Promise<Array>} Page summaries
 */
async function processIndividualPages(client, pagesToProcess, ocrDir, summariesDir) {
  const concurrency = CONFIG.pageConcurrency;
  log('info', `📝 Using per-page processing (concurrency: ${concurrency})`);
  const results = [];

  // Process pages in parallel batches with concurrency limit
  for (let i = 0; i < pagesToProcess.length; i += concurrency) {
    const batch = pagesToProcess.slice(i, i + concurrency);
    const batchLabel = batch.map((p) => p.pageNumber).join(', ');
    log('info', `🚀 Processing batch [${batchLabel}] (${Math.min(i + concurrency, pagesToProcess.length)}/${pagesToProcess.length})`);

    const batchPromises = batch.map(async (page) => {
      const { pageNumber } = page;
      const ocrPath = path.join(ocrDir, page.ocrFile);
      const ocrData = JSON.parse(fs.readFileSync(ocrPath, 'utf-8'));

      try {
        const summary = await processPage(client, pageNumber, ocrData);
        savePageCache(summariesDir, pageNumber, summary);
        log('info', `✅ Page ${pageNumber} analyzed`);
        return summary;
      } catch (err) {
        log('error', `Page ${pageNumber} failed: ${err.message}`);
        const errorSummary = {
          pageNumber,
          pageType: 'error',
          error: err.message,
          extractedInfo: {},
          ambiguousTexts: [],
          openQuestions: [`Error: ${err.message}`],
        };
        savePageCache(summariesDir, pageNumber, errorSummary);
        return errorSummary;
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Delay between batches to respect rate limits (skip after last batch)
    if (i + concurrency < pagesToProcess.length) {
      await sleep(CONFIG.requestDelayMs);
    }
  }

  return results;
}

/**
 * Collect all tables from page summaries (deterministic, no LLM dependency)
 * This ensures tables extracted per-page are never lost during merge.
 * @param {Array<object>} pageSummaries - Per-page summary objects from LLM
 * @returns {Array<{title: string, markdownTable: string, notes?: string}>} Collected tables
 */
function collectTablesFromPageSummaries(pageSummaries) {
  const tables = [];
  for (const page of pageSummaries) {
    const pageTables = page?.extractedInfo?.tables || [];
    for (const t of pageTables) {
      if (t.markdownTable || t.title) {
        tables.push({
          title: t.title || `Table (page ${page.pageNumber})`,
          markdownTable: t.markdownTable || '',
          notes: t.notes || null,
        });
      }
    }
  }
  return tables;
}

/**
 * Save synthesis results and update manifest
 * @param {object} synthesis - Epic synthesis result (merged)
 * @param {string} llmDir - Path to LLM output directory
 * @param {string} outputDir - Path to output directory
 * @param {object} stats - Processing statistics
 * @param {Array<{pageNumber: number, blocks: Array, tables?: Array}>} [allPages] - OCR pages for validation
 * @param {Array} [pageSummaries] - Per-page summaries for evidence validation
 */
function saveSynthesisResults(synthesis, llmDir, outputDir, stats, allPages = null, pageSummaries = null) {
  // For evidence coverage validation, check per-page summaries (Pass 1)
  // because the merge step intentionally removes evidence IDs
  let validationTarget = synthesis;
  if (pageSummaries && pageSummaries.length > 0) {
    // Build a temporary object containing all per-page evidence references
    validationTarget = {
      ...synthesis,
      _pageSummaries: pageSummaries,
    };
  }
  const validation = validateEvidence(validationTarget, allPages);

  // Log validation issues
  if (validation.issues.length > 0) {
    log('warn', 'Validation warnings:');
    validation.issues.forEach((i) => log('warn', `  - ${i}`));
  }

  // Log validation flags
  if (validation.flags.length > 0) {
    for (const flag of validation.flags) {
      log(flag.level, `[VALIDATION] ${flag.message}`);
    }
  }

  // Log completeness metrics
  if (validation.completeness) {
    log(
      'info',
      `📊 OCR Coverage: ${validation.completeness.percentage}% (${validation.completeness.usedCount}/${validation.completeness.totalCount} evidence IDs used)`,
    );
  }

  // Add validation results to synthesis
  synthesis._validation = {
    issues: validation.issues,
    flags: validation.flags,
    completeness: validation.completeness,
    hallucinated: validation.referenceValidation?.hallucinated || [],
  };

  const synthesisPath = path.join(llmDir, 'epic_synthesis.json');
  fs.writeFileSync(synthesisPath, JSON.stringify(synthesis, null, 2));
  log('info', '✅ Epic synthesis complete');

  const manifestPath = path.join(outputDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.llm = {
      provider: stats.providerName,
      model: stats.model,
      mergeProvider: stats.mergeProvider || stats.providerName,
      mergeModel: stats.mergeModel || stats.model,
      totalPages: stats.totalPages,
      successPages: stats.successCount,
      errorPages: stats.errorCount,
      cachedPages: stats.cachedCount,
      completedAt: new Date().toISOString(),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
}

/**
 * Main entry point
 * @returns {Promise<void>} Promise that resolves when synthesis completes
 */
async function main() {
  const args = parseArgs();

  if (!args.output) {
    console.error('Usage: node synthesize.mjs --output <outputDir> [--force]');
    process.exit(1);
  }

  const outputDir = path.resolve(args.output);
  const ocrDir = path.join(outputDir, 'ocr');
  const llmDir = path.join(outputDir, 'llm');
  const summariesDir = path.join(llmDir, 'page_summaries');

  // Validate OCR directory
  if (!fs.existsSync(ocrDir)) {
    console.error(`❌ OCR directory not found: ${ocrDir}`);
    process.exit(1);
  }

  // Create output directories
  fs.mkdirSync(llmDir, { recursive: true });
  fs.mkdirSync(summariesDir, { recursive: true });

  // Initialize file logging for debugging
  initFileLogging(outputDir);

  // Initialize LLM client
  const client = createLLMClient();
  const providerName = process.env.LLM_PROVIDER || 'gemini';
  log('info', `Using LLM provider: ${providerName} (model: ${client.model})`);
  log('debug', 'Config:', CONFIG);

  // Load OCR files
  const allPages = loadOcrFiles(ocrDir);

  // Prepare cache and pages to process
  const { pageSummaries, pagesToProcess, cachedCount } = preparePageCache(allPages, summariesDir, args.force);

  // Process pages if any remain
  if (pagesToProcess.length > 0) {
    const supportsBatch = client instanceof GitHubModelsClient;
    const newResults = supportsBatch
      ? await processBatchPages(client, pagesToProcess, summariesDir)
      : await processIndividualPages(client, pagesToProcess, ocrDir, summariesDir);
    pageSummaries.push(...newResults);
  }

  // Sort summaries by page number
  pageSummaries.sort((a, b) => a.pageNumber - b.pageNumber);

  // Calculate stats
  const successCount = pageSummaries.filter((p) => p.pageType !== 'error').length;
  const errorCount = pageSummaries.filter((p) => p.pageType === 'error').length;
  const errorPages = pageSummaries.filter((p) => p.pageType === 'error').map((p) => p.pageNumber);
  log('info', `\n📊 Pass 1 complete: ${successCount} success, ${errorCount} errors, ${cachedCount} cached`);

  // ABORT if any page failed - incomplete data leads to unreliable output
  if (errorCount > 0) {
    log('error', `\n❌ ABORT: ${errorCount} page(s) failed extraction: [${errorPages.join(', ')}]`);
    log('error', '   Merging with missing pages would produce incomplete/unreliable output.');
    log('error', '   Fix the errors above (check network/API quota) and re-run.');
    log('error', '   Tip: Successfully extracted pages are cached - only failed pages will be re-processed.');
    await closeFileLogging();
    process.exit(1);
  }

  // Pass 2: Merge synthesis (optionally use different provider with higher token limits)
  log('info', '\n🔄 Running merge synthesis...');

  // Create merge client (Gemini/OpenAI with higher token limits)
  const { client: mergeClient, provider: mergeProvider, model: mergeModel } = createMergeClient();
  const effectiveMergeClient = mergeClient || client;
  const effectiveMergeProvider = mergeProvider || providerName;
  const effectiveMergeModel = mergeModel || client.model;

  if (mergeClient) {
    log('info', `🔀 Using separate merge client: ${mergeProvider} (${mergeModel})`);
  }

  try {
    // Pass llmDir for progress saving (resume capability)
    const synthesis = await mergeSynthesis(effectiveMergeClient, pageSummaries, llmDir);

    // Ensure tables from page summaries are preserved in final synthesis
    // LLM merge may drop/truncate tables due to output token limits,
    // so we collect them directly from page summaries (deterministic, no LLM dependency)
    const mergedTables = synthesis.tables || [];
    const pageTables = collectTablesFromPageSummaries(pageSummaries);
    if (pageTables.length > 0 && mergedTables.length === 0) {
      log('info', `📊 Injecting ${pageTables.length} tables from page summaries (merge LLM returned 0)`);
      synthesis.tables = pageTables;
    } else if (pageTables.length > mergedTables.length) {
      log('info', `📊 Supplementing tables: merge has ${mergedTables.length}, pages have ${pageTables.length}`);
      // Merge LLM tables + page tables (deduplicate by title)
      const existingTitles = new Set(mergedTables.map((t) => t.title?.toLowerCase()));
      const newTables = pageTables.filter((t) => !existingTitles.has(t.title?.toLowerCase()));
      synthesis.tables = [...mergedTables, ...newTables];
    }
    if (synthesis.tables?.length > 0) {
      log('info', `📊 Final output: ${synthesis.tables.length} specification tables`);
    }

    saveSynthesisResults(
      synthesis,
      llmDir,
      outputDir,
      {
        providerName,
        model: client.model,
        mergeProvider: effectiveMergeProvider,
        mergeModel: effectiveMergeModel,
        totalPages: pageSummaries.length,
        successCount,
        errorCount,
        cachedCount,
      },
      allPages,
      pageSummaries,
    );
  } catch (err) {
    log('error', `Merge synthesis failed: ${err.message}`);
    await closeFileLogging();
    process.exit(1);
  }

  // Close log stream before exit
  await closeFileLogging();
}

main().catch(async (err) => {
  console.error(`❌ Synthesize failed: ${err.message}`);
  await closeFileLogging();
  process.exit(1);
});

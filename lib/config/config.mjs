/**
 * @module config
 * Central configuration for the synthesize pipeline.
 * Reads environment variables with sensible defaults.
 */

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

export const CONFIG = getConfig();

// Cache version - increment when prompt/extraction logic changes
// This ensures stale cache is invalidated when synthesis strategy changes
export const CACHE_VERSION = '1.2.0'; // Bumped: OOXML cache invalidation + callout→cell mapping

// ============================================================================
// MERGE CONSTANTS (extracted from magic numbers for maintainability)
// ============================================================================

/**
 * Merge processing constants - adjust based on provider capabilities
 * @constant {object} MERGE_CONFIG
 */
export const MERGE_CONFIG = {
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
export const GEMINI_QUOTA = {
  // Free tier: 20 requests per day per model
  REQUESTS_PER_DAY_PER_MODEL: 20,
  // Available models for rotation
  DEFAULT_MODELS: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-pro'],
};

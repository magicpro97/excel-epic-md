/**
 * @module gemini-client
 * Gemini API client with model rotation support for rate limit handling.
 */

import fs from 'fs';
import { BaseLLMClient } from './base-client.mjs';
import { GEMINI_QUOTA, MERGE_CONFIG } from '../config/config.mjs';
import { log } from '../utils/logger.mjs';
import { RUN_STATS } from '../stats/run-stats.mjs';

export class GeminiClient extends BaseLLMClient {
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
   * Generate response using Vision (image + text) for pages with no OCR blocks.
   * Used as fallback for sheets containing embedded UI screenshots/mockups.
   * @param {string} imagePath - Absolute path to PNG file
   * @param {string} prompt - Text prompt
   * @param {string|null} systemInstruction - System instruction
   * @returns {Promise<object>} Parsed JSON response
   */
  async generateVision(imagePath, prompt, systemInstruction = null) {
    const imageData = fs.readFileSync(imagePath);
    const base64Image = imageData.toString('base64');
    const body = {
      contents: [
        {
          parts: [{ inlineData: { mimeType: 'image/png', data: base64Image } }, { text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: this.getMaxTokens(),
        responseMimeType: 'application/json',
      },
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    return await this.generateNonStreaming(body, MERGE_CONFIG.ANTHROPIC_STYLE_MAX_RETRIES);
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

    // Track token usage for run report
    const usageMeta = data.usageMetadata;
    if (usageMeta) {
      RUN_STATS.trackRequest(
        'gemini',
        this.model,
        usageMeta.promptTokenCount || 0,
        usageMeta.candidatesTokenCount || 0,
      );
    } else {
      // No usage metadata — count the request anyway (0 tokens)
      RUN_STATS.trackRequest('gemini', this.model, 0, 0);
    }

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

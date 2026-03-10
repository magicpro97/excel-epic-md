/**
 * @module github-models-client
 * GitHub Models API client (Azure AI inference endpoint) with model rotation.
 */

import { BaseLLMClient } from './base-client.mjs';
import { CONFIG, MERGE_CONFIG } from '../config/config.mjs';
import { log } from '../utils/logger.mjs';
import { RUN_STATS } from '../stats/run-stats.mjs';

export class GitHubModelsClient extends BaseLLMClient {
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
   * Track token usage from a successful API response
   * @param {object} data - API response data
   * @private
   */
  trackUsage(data) {
    const usage = data.usage;
    const prompt = usage ? usage.prompt_tokens || 0 : 0;
    const completion = usage ? usage.completion_tokens || 0 : 0;
    RUN_STATS.trackRequest('github-models', this.model, prompt, completion);
  }

  /**
   * Handle non-OK response: rate limits, server errors, other errors
   * @param {globalThis.Response} response - Fetch response
   * @param {number} attempt - Current attempt number
   * @returns {Promise<'continue'|'throw'>} Action to take
   * @throws {Error} On unrecoverable errors
   * @private
   */
  async handleErrorResponse(response, attempt) {
    const errorText = await response.text();

    if (response.status === 429) {
      const action = await this.handleRateLimitFromText(errorText, attempt);
      if (action === 'retry' || action === 'wait') return 'continue';
      throw new Error(
        `All GitHub Models exhausted (daily limits). Models tried: ${Array.from(this.exhaustedModels).join(', ')}`,
      );
    }

    if (this.isServerError(response.status) && attempt < this.maxRetries) {
      const delay = MERGE_CONFIG.CONNECTION_BASE_DELAY_MS * attempt;
      log(
        'warn',
        `⚠️ GitHub Models server error (${response.status}), retrying in ${delay}ms (${attempt}/${this.maxRetries})...`,
      );
      await this.sleep(delay);
      return 'continue';
    }

    if (this.isServerError(response.status)) {
      throw new Error(`GitHub Models server error after ${this.maxRetries} retries: ${response.status}`);
    }

    throw new Error(`GitHub Models API error (${this.model}): ${response.status} - ${errorText}`);
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
          this.trackUsage(data);
          const text = data.choices?.[0]?.message?.content;
          if (!text) throw new Error('Empty response from GitHub Models');
          return this.parseJsonResponse(text);
        }

        const action = await this.handleErrorResponse(response, attempt);
        if (action === 'continue') continue;
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

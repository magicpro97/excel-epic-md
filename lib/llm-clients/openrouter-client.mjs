/**
 * @module openrouter-client
 * OpenRouter API client — unified access to multiple LLM providers.
 */

import { MERGE_CONFIG } from '../config/config.mjs';
import { RUN_STATS } from '../stats/run-stats.mjs';
import { log } from '../utils/logger.mjs';
import { BaseLLMClient } from './base-client.mjs';

export class OpenRouterClient extends BaseLLMClient {
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

    // Track token usage for run report
    if (data.usage) {
      RUN_STATS.trackRequest(
        'openrouter',
        this.model,
        data.usage.prompt_tokens || 0,
        data.usage.completion_tokens || 0,
      );
    } else {
      RUN_STATS.trackRequest('openrouter', this.model, 0, 0);
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

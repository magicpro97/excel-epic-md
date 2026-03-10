/**
 * @module openai-client
 * OpenAI API client with retry logic and rate limit handling.
 */

import { BaseLLMClient } from './base-client.mjs';
import { MERGE_CONFIG } from '../config/config.mjs';
import { log } from '../utils/logger.mjs';
import { RUN_STATS } from '../stats/run-stats.mjs';

export class OpenAIClient extends BaseLLMClient {
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
        // Track token usage for run report
        if (data.usage) {
          RUN_STATS.trackRequest(
            'openai',
            this.model,
            data.usage.prompt_tokens || 0,
            data.usage.completion_tokens || 0,
          );
        } else {
          RUN_STATS.trackRequest('openai', this.model, 0, 0);
        }
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

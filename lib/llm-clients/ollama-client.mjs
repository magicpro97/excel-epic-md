/**
 * @module ollama-client
 * Ollama client (local LLM) with retry logic.
 */

import { BaseLLMClient } from './base-client.mjs';
import { MERGE_CONFIG } from '../config/config.mjs';
import { log } from '../utils/logger.mjs';
import { RUN_STATS } from '../stats/run-stats.mjs';

export class OllamaClient extends BaseLLMClient {
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
        // Track token usage for run report (Ollama fields)
        RUN_STATS.trackRequest('ollama', this.model, data.prompt_eval_count || 0, data.eval_count || 0);
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

/**
 * @module azure-openai-client
 * Azure OpenAI API client with enterprise SLA and stability.
 */

import { MERGE_CONFIG } from '../config/config.mjs';
import { RUN_STATS } from '../stats/run-stats.mjs';
import { log } from '../utils/logger.mjs';
import { BaseLLMClient } from './base-client.mjs';

export class AzureOpenAIClient extends BaseLLMClient {
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
        // Track token usage for run report
        if (data.usage) {
          RUN_STATS.trackRequest(
            'azure-openai',
            this.deployment,
            data.usage.prompt_tokens || 0,
            data.usage.completion_tokens || 0,
          );
        } else {
          RUN_STATS.trackRequest('azure-openai', this.deployment, 0, 0);
        }
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

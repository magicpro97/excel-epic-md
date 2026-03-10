import { CONFIG, MERGE_CONFIG } from '../config/config.mjs';
import { log } from '../utils/logger.mjs';
import { isRetryableMessage, sleep } from '../utils/helpers.mjs';
import { OpenRouterClient } from '../llm-clients/openrouter-client.mjs';

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

export { createOpenRouterFallbackClient, generateWithFallback };

/**
 * @module pricing
 * Model pricing table — dynamic from model-pricing.json with hardcoded fallback.
 * Run `bun scripts/update-pricing.mjs` to fetch latest from LiteLLM.
 */

import fs from 'fs';
import path from 'path';
import { fetchAndSavePricing } from '../../scripts/update-pricing.mjs';

// ============================================================================
// MODEL PRICING TABLE (dynamic from model-pricing.json + hardcoded fallback)
// ============================================================================

/**
 * Hardcoded fallback pricing — used when model-pricing.json is missing or stale.
 * Run `bun scripts/update-pricing.mjs` to fetch latest from LiteLLM.
 * @constant {Array<{pattern: RegExp, provider: string, inputPer1M: number, outputPer1M: number}>}
 */
export const FALLBACK_PRICING = [
  // Gemini models
  { pattern: /gemini-2\.5-pro/i, provider: 'gemini', inputPer1M: 1.25, outputPer1M: 5.0 },
  { pattern: /gemini-2\.5-flash/i, provider: 'gemini', inputPer1M: 0.15, outputPer1M: 0.6 },
  { pattern: /gemini-2\.0-flash/i, provider: 'gemini', inputPer1M: 0.075, outputPer1M: 0.3 },
  { pattern: /gemini-1\.5-pro/i, provider: 'gemini', inputPer1M: 1.25, outputPer1M: 5.0 },
  { pattern: /gemini-1\.5-flash/i, provider: 'gemini', inputPer1M: 0.075, outputPer1M: 0.3 },
  // OpenAI direct
  { pattern: /^gpt-4\.1-mini/i, provider: 'openai', inputPer1M: 0.4, outputPer1M: 1.6 },
  { pattern: /^gpt-4\.1-nano/i, provider: 'openai', inputPer1M: 0.1, outputPer1M: 0.4 },
  { pattern: /^gpt-4\.1/i, provider: 'openai', inputPer1M: 2.0, outputPer1M: 8.0 },
  { pattern: /^gpt-4o-mini/i, provider: 'openai', inputPer1M: 0.15, outputPer1M: 0.6 },
  { pattern: /^gpt-4o/i, provider: 'openai', inputPer1M: 2.5, outputPer1M: 10.0 },
  { pattern: /^gpt-4-turbo/i, provider: 'openai', inputPer1M: 10.0, outputPer1M: 30.0 },
  { pattern: /^o3-mini/i, provider: 'openai', inputPer1M: 1.1, outputPer1M: 4.4 },
  { pattern: /^o3/i, provider: 'openai', inputPer1M: 2.0, outputPer1M: 8.0 },
  { pattern: /^o4-mini/i, provider: 'openai', inputPer1M: 1.1, outputPer1M: 4.4 },
  // Anthropic Claude
  { pattern: /claude-3-5-sonnet/i, provider: 'anthropic', inputPer1M: 3.0, outputPer1M: 15.0 },
  { pattern: /claude-3-5-haiku/i, provider: 'anthropic', inputPer1M: 0.8, outputPer1M: 4.0 },
  { pattern: /claude-3-opus/i, provider: 'anthropic', inputPer1M: 15.0, outputPer1M: 75.0 },
  { pattern: /claude-3-haiku/i, provider: 'anthropic', inputPer1M: 0.25, outputPer1M: 1.25 },
];

/**
 * Dynamic pricing lookup table loaded from model-pricing.json.
 * Keyed by model name (lowercase) → { provider, inputPer1M, outputPer1M }.
 * Populated by loadDynamicPricing() at startup.
 * @type {Map<string, {provider: string, inputPer1M: number, outputPer1M: number}>}
 */
export const DYNAMIC_PRICING = new Map();

/** @type {string|null} Timestamp when pricing was last fetched */
let PRICING_UPDATED_AT = null;

/**
 * Load pricing from model-pricing.json into DYNAMIC_PRICING map.
 * @param {string} pricingPath - Path to model-pricing.json
 * @returns {number} Number of models loaded
 */
export function loadPricingFromFile(pricingPath) {
  try {
    if (!fs.existsSync(pricingPath)) return 0;

    const data = JSON.parse(fs.readFileSync(pricingPath, 'utf-8'));
    if (!data.models || typeof data.models !== 'object') return 0;

    PRICING_UPDATED_AT = data._meta?.updatedAt || null;
    DYNAMIC_PRICING.clear();

    let count = 0;
    for (const [modelName, info] of Object.entries(data.models)) {
      if (info.inputPer1M != null || info.outputPer1M != null) {
        DYNAMIC_PRICING.set(modelName.toLowerCase(), {
          provider: info.provider || 'unknown',
          inputPer1M: info.inputPer1M || 0,
          outputPer1M: info.outputPer1M || 0,
        });
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Fetch latest pricing from LiteLLM, save to file, and load into memory.
 * Always attempts a fresh fetch. Falls back to existing file if fetch fails.
 * Called once at pipeline startup — the fetch takes ~1-2s and ensures accurate cost tracking.
 * @returns {Promise<void>}
 */
export async function refreshPricing() {
  const pricingPath = path.join(path.dirname(new URL(import.meta.url).pathname), '../../scripts/model-pricing.json');

  // Always try to fetch fresh pricing
  const result = await fetchAndSavePricing({ quiet: true });

  if (result) {
    // Fetch succeeded → file was saved, load it
    const count = loadPricingFromFile(pricingPath);
    console.log(`💰 Fetched & loaded ${count} model prices (fresh from LiteLLM)`);
    return;
  }

  // Fetch failed → try loading existing cached file
  const count = loadPricingFromFile(pricingPath);
  if (count > 0) {
    const staleNote = PRICING_UPDATED_AT ? ` (cached: ${PRICING_UPDATED_AT.slice(0, 10)})` : '';
    console.log(`💰 Loaded ${count} model prices from cache${staleNote}`);
  } else {
    console.log('💰 Using hardcoded fallback pricing (no cache available)');
  }
}

/**
 * Estimate cost in USD from model name and token counts.
 * Strategy: dynamic lookup (exact → prefix) → fallback regex table → $0.
 * @param {string} providerHint - Provider key (e.g. 'gemini', 'github-models', 'openai')
 * @param {string} model - Model name string
 * @param {number} inputTokens - Prompt token count
 * @param {number} outputTokens - Completion token count
 * @returns {number} Estimated cost in USD
 */
export function estimateCost(providerHint, model, inputTokens, outputTokens) {
  // Free providers — always $0
  if (providerHint === 'github-models' || providerHint === 'ollama') return 0;

  const modelLower = model.toLowerCase();

  // 1. Dynamic pricing: exact match
  if (DYNAMIC_PRICING.size > 0) {
    const exact = DYNAMIC_PRICING.get(modelLower);
    if (exact) {
      return (inputTokens / 1_000_000) * exact.inputPer1M + (outputTokens / 1_000_000) * exact.outputPer1M;
    }

    // 2. Dynamic pricing: prefix match (e.g., "gpt-4o-2024-08-06" → "gpt-4o")
    for (const [key, val] of DYNAMIC_PRICING) {
      if (modelLower.startsWith(key) || key.startsWith(modelLower)) {
        return (inputTokens / 1_000_000) * val.inputPer1M + (outputTokens / 1_000_000) * val.outputPer1M;
      }
    }
  }

  // 3. Hardcoded fallback (regex patterns)
  const entry = FALLBACK_PRICING.find((e) => e.pattern.test(model));
  if (entry) {
    return (inputTokens / 1_000_000) * entry.inputPer1M + (outputTokens / 1_000_000) * entry.outputPer1M;
  }

  return 0;
}

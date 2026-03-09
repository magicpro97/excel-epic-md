#!/usr/bin/env bun
/**
 * Fetch latest model pricing from LiteLLM's community-maintained database.
 *
 * Source: https://github.com/BerriAI/litellm (1000+ models, updated frequently)
 *
 * Usage:
 *   bun scripts/update-pricing.mjs           # Fetch & update model-pricing.json
 *   bun scripts/update-pricing.mjs --dry-run  # Preview without saving
 *   bun scripts/update-pricing.mjs --stats    # Show pricing stats only
 *
 * Recommended: Run monthly or when new models are released.
 * The fetched data is cached in scripts/model-pricing.json and used by synthesize.mjs.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRICING_FILE = path.join(__dirname, 'model-pricing.json');

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/**
 * Provider mapping from LiteLLM provider names to our provider keys.
 * LiteLLM uses "litellm_provider" field with values like "openai", "vertex_ai-language-models", etc.
 * @constant {Object<string, string>}
 */
const PROVIDER_MAP = {
  openai: 'openai',
  azure: 'azure-openai',
  'azure-openai': 'azure-openai',
  azure_ai: 'azure-openai',
  anthropic: 'anthropic',
  'vertex_ai-anthropic_models': 'anthropic',
  gemini: 'gemini',
  'vertex_ai-language-models': 'gemini',
  'vertex_ai-text-models': 'gemini',
  cohere: 'cohere',
  mistral: 'mistral',
  groq: 'groq',
  deepseek: 'deepseek',
  together_ai: 'together',
  fireworks_ai: 'fireworks',
  ollama: 'ollama',
  bedrock: 'bedrock',
  vertex_ai: 'gemini',
};

/**
 * Models we actually care about (used or likely to be used in synthesize.mjs).
 * Broader patterns to capture variants (e.g., gpt-4o-2024-08-06).
 * If a model name contains any of these substrings, it's included.
 * @constant {string[]}
 */
const RELEVANT_PATTERNS = [
  // Gemini
  'gemini-2.5',
  'gemini-2.0',
  'gemini-1.5',
  // OpenAI
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-4.1',
  'gpt-4.5',
  'o1-mini',
  'o1-preview',
  'o3-mini',
  'o3',
  'o4-mini',
  // Anthropic
  'claude-3-5',
  'claude-3.5',
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-haiku',
  'claude-sonnet-4',
  'claude-opus-4',
  // DeepSeek
  'deepseek-chat',
  'deepseek-r1',
  'deepseek-v3',
  // Mistral
  'mistral-large',
  'mistral-small',
];

/**
 * Providers to exclude (bad/irrelevant pricing data).
 * wandb = GPU-hour costs, not token costs.
 * gradient_ai, lambda_ai = self-hosted inference pricing.
 * @constant {Set<string>}
 */
const EXCLUDED_PROVIDERS = new Set([
  'wandb',
  'gradient_ai',
  'lambda_ai',
  'nscale',
  'gmi',
  'volcengine',
  'oci',
  'llamagate',
  'hyperbolic',
  'sambanova',
]);

/**
 * Maximum reasonable per-1M-token cost (USD). Anything above is likely bad data.
 * Claude 3 Opus at $75/1M output is the highest known legitimate price.
 * @constant {number}
 */
const MAX_REASONABLE_COST_PER_1M = 200;

/**
 * Fetch raw pricing data from LiteLLM GitHub repository
 * @returns {Promise<object>} Raw LiteLLM pricing data
 */
async function fetchLiteLLMPricing() {
  console.log(`📡 Fetching from LiteLLM...`);
  console.log(`   URL: ${LITELLM_URL}`);

  const response = await fetch(LITELLM_URL, {
    headers: { 'User-Agent': 'excel-epic-md/update-pricing' },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const modelCount = Object.keys(data).length;
  console.log(`   ✅ Fetched ${modelCount} models from LiteLLM`);
  return data;
}

/**
 * Check if a model name matches our relevant patterns
 * @param {string} modelName - Model name to check
 * @returns {boolean} True if model is relevant
 */
function isRelevantModel(modelName) {
  const lower = modelName.toLowerCase();
  return RELEVANT_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/**
 * Normalize provider from LiteLLM format to our format
 * @param {string} litellmProvider - LiteLLM provider string
 * @param {string} modelName - Model name for fallback detection
 * @returns {string} Normalized provider key
 */
function normalizeProvider(litellmProvider, modelName) {
  if (!litellmProvider) {
    // Infer from model name
    if (
      modelName.startsWith('gpt-') ||
      modelName.startsWith('o1') ||
      modelName.startsWith('o3') ||
      modelName.startsWith('o4')
    )
      return 'openai';
    if (modelName.includes('claude')) return 'anthropic';
    if (modelName.includes('gemini')) return 'gemini';
    if (modelName.includes('deepseek')) return 'deepseek';
    if (modelName.includes('mistral')) return 'mistral';
    if (modelName.includes('llama')) return 'meta';
    return 'unknown';
  }

  return PROVIDER_MAP[litellmProvider] || litellmProvider;
}

/**
 * Strip provider prefix from model name (e.g., "openai/gpt-4o" → "gpt-4o")
 * @param {string} modelName - Raw model name
 * @returns {string} Cleaned model name
 */
function stripProviderPrefix(modelName) {
  // Common prefixes: openai/, azure/, anthropic/, vertex_ai/, etc.
  const prefixPatterns = [
    /^openai\//i,
    /^azure\//i,
    /^azure_ai\//i,
    /^anthropic\//i,
    /^vertex_ai\//i,
    /^bedrock\//i,
    /^together_ai\//i,
    /^fireworks_ai\//i,
    /^groq\//i,
    /^deepseek\//i,
    /^mistral\//i,
    /^cohere\//i,
  ];

  for (const prefix of prefixPatterns) {
    if (prefix.test(modelName)) {
      return modelName.replace(prefix, '');
    }
  }
  return modelName;
}

/**
 * Transform LiteLLM data into our pricing format
 * @param {object} rawData - Raw LiteLLM pricing data
 * @returns {{ models: object, stats: object }} Transformed pricing data and stats
 */
function transformPricing(rawData) {
  const models = {};
  const stats = { total: 0, relevant: 0, skipped: 0, byProvider: {} };

  for (const [rawName, info] of Object.entries(rawData)) {
    stats.total++;

    // Skip sample_spec and non-model entries
    if (rawName === 'sample_spec' || !info) continue;

    const cleanName = stripProviderPrefix(rawName);

    // Only include relevant models (skip thousands of obscure ones)
    if (!isRelevantModel(cleanName)) {
      stats.skipped++;
      continue;
    }

    // Skip if no pricing data
    const inputCost = info.input_cost_per_token;
    const outputCost = info.output_cost_per_token;
    if (inputCost == null && outputCost == null) {
      stats.skipped++;
      continue;
    }

    const provider = normalizeProvider(info.litellm_provider, cleanName);

    // Skip excluded providers (bad pricing data)
    if (EXCLUDED_PROVIDERS.has(provider) || EXCLUDED_PROVIDERS.has(info.litellm_provider)) {
      stats.skipped++;
      continue;
    }

    // Convert per-token to per-1M tokens (our format)
    const inputPer1M = inputCost != null ? parseFloat((inputCost * 1_000_000).toFixed(4)) : 0;
    const outputPer1M = outputCost != null ? parseFloat((outputCost * 1_000_000).toFixed(4)) : 0;

    // Sanity check: skip absurdly high pricing (likely bad data)
    if (inputPer1M > MAX_REASONABLE_COST_PER_1M || outputPer1M > MAX_REASONABLE_COST_PER_1M) {
      stats.skipped++;
      continue;
    }

    // Use cleanName as key, prefer non-prefixed version
    // If duplicate, keep the one with pricing data or the first one
    if (!models[cleanName] || (inputPer1M > 0 && !models[cleanName].inputPer1M)) {
      models[cleanName] = { provider, inputPer1M, outputPer1M };

      // Also store context window if available
      if (info.max_tokens) {
        models[cleanName].maxOutputTokens = info.max_tokens;
      }
      if (info.max_input_tokens) {
        models[cleanName].maxInputTokens = info.max_input_tokens;
      }
    }

    stats.relevant++;
    stats.byProvider[provider] = (stats.byProvider[provider] || 0) + 1;
  }

  return { models, stats };
}

/**
 * Save pricing data to JSON file
 * @param {object} models - Transformed model pricing data
 * @param {object} stats - Transformation statistics
 */
function savePricing(models, stats) {
  const output = {
    _meta: {
      updatedAt: new Date().toISOString(),
      source: 'litellm/model_prices_and_context_window.json',
      sourceUrl: LITELLM_URL,
      note: "Run 'bun scripts/update-pricing.mjs' to refresh. Auto-generated, do not edit manually.",
      totalModels: Object.keys(models).length,
      fetchStats: stats,
    },
    models,
  };

  fs.writeFileSync(PRICING_FILE, JSON.stringify(output, null, 2) + '\n');
  console.log(`\n💾 Saved to: ${PRICING_FILE}`);
  console.log(`   ${Object.keys(models).length} models (from ${stats.total} total in LiteLLM)`);
}

/**
 * Print pricing summary table
 * @param {object} models - Model pricing data
 */
function printSummary(models) {
  console.log('\n┌──────────────────────────────────────────────────────────────────┐');
  console.log('│                    📊 MODEL PRICING SUMMARY                     │');
  console.log('└──────────────────────────────────────────────────────────────────┘\n');

  // Group by provider
  const byProvider = {};
  for (const [name, info] of Object.entries(models)) {
    const p = info.provider;
    if (!byProvider[p]) byProvider[p] = [];
    byProvider[p].push({ name, ...info });
  }

  for (const [provider, providerModels] of Object.entries(byProvider).sort()) {
    console.log(`\n── ${provider} ${'─'.repeat(Math.max(0, 55 - provider.length))}`);
    // Sort by input cost descending
    providerModels.sort((a, b) => b.inputPer1M - a.inputPer1M);
    for (const m of providerModels) {
      const input = `$${m.inputPer1M.toFixed(2)}`.padStart(8);
      const output = `$${m.outputPer1M.toFixed(2)}`.padStart(8);
      const name = m.name.padEnd(35);
      console.log(`  ${name} in:${input}/1M  out:${output}/1M`);
    }
  }
}

// ============================================================================
// PUBLIC API (importable by synthesize.mjs)
// ============================================================================

/**
 * Fetch latest pricing from LiteLLM, transform, and save to model-pricing.json.
 * Designed to be called from other scripts (e.g., synthesize.mjs at startup).
 * @param {{ quiet?: boolean }} [options] - Options
 * @returns {Promise<{ models: object, count: number } | null>} Pricing data or null on failure
 */
export async function fetchAndSavePricing({ quiet = false } = {}) {
  try {
    if (!quiet) console.log('📡 Fetching model pricing from LiteLLM...');

    const response = await fetch(LITELLM_URL, {
      headers: { 'User-Agent': 'excel-epic-md/update-pricing' },
      signal: AbortSignal.timeout(15000), // 15s timeout for inline use
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const rawData = await response.json();
    const { models, stats } = transformPricing(rawData);
    const count = Object.keys(models).length;

    savePricing(models, stats);
    if (!quiet) console.log(`💰 Updated ${count} model prices (from ${stats.total} in LiteLLM)`);

    return { models, count };
  } catch (err) {
    if (!quiet) console.warn(`⚠️  Pricing fetch failed (will use cached/fallback): ${err.message}`);
    return null;
  }
}

// ============================================================================
// CLI MAIN (only when run directly)
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isStats = args.includes('--stats');

  // Stats-only mode: show current pricing file
  if (isStats) {
    if (!fs.existsSync(PRICING_FILE)) {
      console.error('❌ No pricing file found. Run without --stats first.');
      process.exit(1);
    }
    const current = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf-8'));
    console.log(`📅 Last updated: ${current._meta?.updatedAt || 'unknown'}`);
    console.log(`📊 Models: ${current._meta?.totalModels || Object.keys(current.models).length}`);
    printSummary(current.models);
    return;
  }

  try {
    const rawData = await fetchLiteLLMPricing();
    const { models, stats } = transformPricing(rawData);

    console.log(`\n📊 Transformation stats:`);
    console.log(`   Total in LiteLLM: ${stats.total}`);
    console.log(`   Relevant: ${stats.relevant}`);
    console.log(`   Unique models: ${Object.keys(models).length}`);
    console.log(`   By provider: ${JSON.stringify(stats.byProvider, null, 2)}`);

    printSummary(models);

    if (isDryRun) {
      console.log('\n🔍 Dry run — no changes saved.');
    } else {
      savePricing(models, stats);
      console.log('\n✅ Pricing updated successfully!');
      console.log('💡 Tip: Run this monthly or when new models are released.');
    }
  } catch (err) {
    console.error(`❌ Failed: ${err.message}`);
    process.exit(1);
  }
}

// Only run CLI when executed directly (not imported)
const isDirectRun =
  process.argv[1] && (process.argv[1].endsWith('update-pricing.mjs') || process.argv[1].includes('update-pricing'));
if (isDirectRun) {
  main();
}

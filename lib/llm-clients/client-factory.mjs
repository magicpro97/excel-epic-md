/**
 * @module client-factory
 * Factory functions for creating LLM clients based on environment configuration.
 */

import { GeminiClient } from './gemini-client.mjs';
import { GitHubModelsClient } from './github-models-client.mjs';
import { AzureOpenAIClient } from './azure-openai-client.mjs';
import { OpenAIClient } from './openai-client.mjs';
import { OpenRouterClient } from './openrouter-client.mjs';
import { OllamaClient } from './ollama-client.mjs';
import { CopilotClient, initCopilotClient } from './copilot-client.mjs';
import { log } from '../utils/logger.mjs';

/**
 * Create LLM client based on environment configuration
 * @returns {Promise<import('./base-client.mjs').BaseLLMClient>} Configured LLM client
 */
export async function createLLMClient() {
  const provider = process.env.LLM_PROVIDER || 'gemini';

  switch (provider.toLowerCase()) {
    case 'gemini': {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY not set in environment');
      }
      const model = process.env.GEMINI_MODEL || 'gemini-1.5-pro';
      log('info', `📡 Using Gemini (${model})`);
      return new GeminiClient(apiKey, model);
    }

    case 'github': {
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error('GITHUB_TOKEN not set (needs "models" scope)');
      }
      // Support model rotation via GITHUB_MODELS (comma-separated)
      const modelsEnv = process.env.GITHUB_MODELS;
      const models = modelsEnv
        ? modelsEnv
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean)
        : [process.env.GITHUB_MODEL || 'gpt-4o'];

      if (models.length > 1) {
        log('info', `📡 Using GitHub Models with rotation: ${models[0]} (+${models.length - 1} fallbacks)`);
      } else {
        log('info', `📡 Using GitHub Models (${models[0]})`);
      }
      return new GitHubModelsClient(token, models);
    }

    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY not set in environment');
      }
      const model = process.env.OPENAI_MODEL || 'gpt-4o';
      log('info', `📡 Using OpenAI (${model})`);
      return new OpenAIClient(apiKey, model);
    }

    case 'ollama': {
      const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
      const model = process.env.OLLAMA_MODEL || 'llama3.2';
      log('info', `📡 Using Ollama local (${model})`);
      return new OllamaClient(host, model);
    }

    case 'copilot': {
      const model = process.env.COPILOT_MODEL || 'gpt-4o';
      log('info', `📡 Using GitHub Copilot (${model}) — initializing...`);
      return await initCopilotClient(model);
    }

    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY not set in environment');
      }
      const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet';
      log('info', `📡 Using OpenRouter (${model})`);
      return new OpenRouterClient(apiKey, model);
    }

    case 'azure': {
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
      const apiKey = process.env.AZURE_OPENAI_API_KEY;
      const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
      const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview';

      if (!endpoint) {
        throw new Error('AZURE_OPENAI_ENDPOINT not set (e.g., https://your-resource.openai.azure.com)');
      }
      if (!apiKey) {
        throw new Error('AZURE_OPENAI_API_KEY not set in environment');
      }
      if (!deployment) {
        throw new Error('AZURE_OPENAI_DEPLOYMENT not set (e.g., gpt-4o)');
      }

      log('info', `📡 Using Azure OpenAI (${deployment}) - Enterprise SLA`);
      return new AzureOpenAIClient(endpoint, apiKey, deployment, apiVersion);
    }

    default:
      throw new Error(
        `Unknown LLM provider: ${provider}. Valid: gemini, github, openai, azure, ollama, openrouter, copilot`,
      );
  }
}

/**
 * Create separate LLM client for merge step (higher token limits)
 * Uses LLM_MERGE_PROVIDER if set, otherwise returns null (use main client)
 * @returns {Promise<{ client: import('./base-client.mjs').BaseLLMClient | null, provider: string | null, model: string | null }>} Merge client info
 */
export async function createMergeClient() {
  const mergeProvider = process.env.LLM_MERGE_PROVIDER;

  // If no merge provider specified, use main client
  if (!mergeProvider) {
    return { client: null, provider: null, model: null };
  }

  switch (mergeProvider.toLowerCase()) {
    case 'gemini': {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        log('warn', 'GEMINI_API_KEY not set, falling back to main provider for merge');
        return { client: null, provider: null, model: null };
      }
      // Support model rotation for merge (each model has 20 req/day limit)
      const modelsStr = process.env.GEMINI_MERGE_MODELS;
      const models = modelsStr ? modelsStr.split(',').map((m) => m.trim()) : null;
      const model = models || process.env.LLM_MERGE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      const displayModel = Array.isArray(model) ? model[0] : model;
      log('info', `📡 Merge client: Gemini (${displayModel}) - 1M token context`);
      return { client: new GeminiClient(apiKey, model), provider: 'gemini', model: displayModel };
    }

    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        log('warn', 'OPENAI_API_KEY not set, falling back to main provider for merge');
        return { client: null, provider: null, model: null };
      }
      const model = process.env.LLM_MERGE_MODEL || process.env.OPENAI_MODEL || 'gpt-4o';
      log('info', `📡 Merge client: OpenAI (${model}) - 128K token context`);
      return { client: new OpenAIClient(apiKey, model), provider: 'openai', model };
    }

    case 'github': {
      // Not recommended for merge (8K limit), but allow if explicitly set
      log('warn', 'GitHub Models has 8K token limit, may fail on large merges');
      return { client: null, provider: null, model: null };
    }

    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        log('warn', 'OPENROUTER_API_KEY not set, falling back to main provider for merge');
        return { client: null, provider: null, model: null };
      }
      const model = process.env.LLM_MERGE_MODEL || process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet';
      const contextSize = model.includes('claude') ? '200K' : '128K';
      log('info', `📡 Merge client: OpenRouter (${model}) - ${contextSize} token context`);
      return { client: new OpenRouterClient(apiKey, model), provider: 'openrouter', model };
    }

    case 'azure': {
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
      const apiKey = process.env.AZURE_OPENAI_API_KEY;
      const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
      const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview';

      if (!endpoint || !apiKey || !deployment) {
        log('warn', 'Azure OpenAI not configured, falling back to main provider for merge');
        return { client: null, provider: null, model: null };
      }

      const mergeDeployment = process.env.LLM_MERGE_MODEL || deployment;
      log('info', `📡 Merge client: Azure OpenAI (${mergeDeployment}) - Enterprise SLA, 128K token context`);
      return {
        client: new AzureOpenAIClient(endpoint, apiKey, mergeDeployment, apiVersion),
        provider: 'azure',
        model: mergeDeployment,
      };
    }

    case 'copilot': {
      const model = process.env.LLM_MERGE_MODEL || process.env.COPILOT_MODEL || 'gpt-4o';
      log('info', `📡 Merge client: Copilot (${model}) — initializing...`);
      const client = await initCopilotClient(model);
      return { client, provider: 'copilot', model };
    }

    default:
      log('warn', `Unknown LLM_MERGE_PROVIDER: ${mergeProvider}, using main provider`);
      return { client: null, provider: null, model: null };
  }
}

/**
 * Check if client is high-capacity (Gemini, OpenAI non-mini, Azure, OpenRouter)
 * @param {import('./base-client.mjs').BaseLLMClient} client - LLM client
 * @returns {boolean} True if high capacity
 */
export function isHighCapacityClient(client) {
  return (
    client instanceof GeminiClient ||
    client instanceof OpenRouterClient ||
    client instanceof AzureOpenAIClient ||
    client instanceof CopilotClient ||
    (client instanceof OpenAIClient && !client.model.includes('mini'))
  );
}

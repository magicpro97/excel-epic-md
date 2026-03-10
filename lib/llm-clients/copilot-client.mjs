/**
 * @module copilot-client
 * GitHub Copilot API client using OAuth device flow authentication.
 */

import fs from 'fs';
import path from 'path';
import { BaseLLMClient } from './base-client.mjs';
import { MERGE_CONFIG } from '../config/config.mjs';
import { log } from '../utils/logger.mjs';
import { RUN_STATS } from '../stats/run-stats.mjs';

/**
 * Copilot OAuth client ID — used by all official Copilot clients.
 * @constant {string}
 */
const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';

/**
 * Default paths where the Copilot VS Code extension stores OAuth tokens.
 * Checked in order: Linux, macOS, Windows (WSL).
 * @constant {string[]}
 */
const COPILOT_TOKEN_PATHS = [
  path.join(process.env.HOME || '~', '.config', 'github-copilot', 'hosts.json'),
  path.join(process.env.HOME || '~', '.config', 'github-copilot', 'apps.json'),
];

/**
 * Load stored GitHub OAuth token from Copilot config files.
 * @returns {string|null} OAuth token or null if not found
 */
function loadCopilotOAuthToken() {
  for (const tokenPath of COPILOT_TOKEN_PATHS) {
    if (fs.existsSync(tokenPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
        // hosts.json format: { "github.com": { "oauth_token": "gho_XXX" } }
        const ghEntry = data['github.com'];
        if (ghEntry?.oauth_token) {
          log('info', `🔑 Loaded Copilot OAuth token from ${tokenPath}`);
          return ghEntry.oauth_token;
        }
        // apps.json format: { "github.com": { "oauth_token": "gho_XXX" } }
        for (const key of Object.keys(data)) {
          if (data[key]?.oauth_token) {
            log('info', `🔑 Loaded Copilot OAuth token from ${tokenPath} (key: ${key})`);
            return data[key].oauth_token;
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }
  return null;
}

/**
 * Save GitHub OAuth token to the standard Copilot config path.
 * @param {string} token - OAuth token to save
 */
function saveCopilotOAuthToken(token) {
  const configDir = path.join(process.env.HOME || '~', '.config', 'github-copilot');
  fs.mkdirSync(configDir, { recursive: true });
  const hostsPath = path.join(configDir, 'hosts.json');
  const data = fs.existsSync(hostsPath) ? JSON.parse(fs.readFileSync(hostsPath, 'utf-8')) : {};
  data['github.com'] = { ...(data['github.com'] || {}), oauth_token: token };
  fs.writeFileSync(hostsPath, JSON.stringify(data, null, 2));
  log('info', `🔑 Saved Copilot OAuth token to ${hostsPath}`);
}

/**
 * Perform GitHub OAuth device flow to get a long-lived access token.
 * Opens browser for user authorization.
 * @returns {Promise<string>} OAuth access token
 */
async function copilotDeviceFlow() {
  // Step 1: Request device code
  const codeRes = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'GithubCopilot/1.155.0',
    },
    body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: 'read:user' }),
  });

  if (!codeRes.ok) {
    throw new Error(`Device flow initiation failed: ${codeRes.status}`);
  }

  const { device_code, user_code, verification_uri, interval } = await codeRes.json();

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║          🔐 GitHub Copilot Authentication               ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  1. Open: ${verification_uri}`);
  console.log(`║  2. Enter code: ${user_code}`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Step 2: Poll for token
  const pollInterval = (interval || 5) * 1000;
  const maxAttempts = 60; // 5 minutes max
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      log('info', '✅ GitHub OAuth authorization successful');
      return tokenData.access_token;
    }
    if (tokenData.error === 'authorization_pending') continue;
    if (tokenData.error === 'slow_down') {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (tokenData.error === 'expired_token') {
      throw new Error('Device code expired — please re-run authentication');
    }
    if (tokenData.error) {
      throw new Error(`OAuth error: ${tokenData.error} — ${tokenData.error_description || ''}`);
    }
  }
  throw new Error('OAuth device flow timed out (5 minutes)');
}

export class CopilotClient extends BaseLLMClient {
  /**
   * @param {string} oauthToken - GitHub OAuth token (gho_XXX)
   * @param {string} model - Model identifier (e.g., 'gpt-4o', 'claude-3.5-sonnet')
   */
  constructor(oauthToken, model = 'gpt-4o') {
    super();
    this.oauthToken = oauthToken;
    this.model = model;
    this.sessionToken = null;
    this.sessionExpiresAt = 0;
    this.baseUrl = 'https://api.githubcopilot.com';
  }

  /**
   * Get or refresh the Copilot session token.
   * Session tokens expire every ~30 minutes.
   * @returns {Promise<string>} Valid session token
   */
  async getSessionToken() {
    // Refresh 60 seconds before expiry
    if (this.sessionToken && Date.now() / 1000 < this.sessionExpiresAt - 60) {
      return this.sessionToken;
    }

    log('info', '🔄 Refreshing Copilot session token...');
    const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: {
        authorization: `token ${this.oauthToken}`,
        'user-agent': 'GithubCopilot/1.155.0',
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      if (res.status === 401) {
        throw new Error(
          'Copilot OAuth token is invalid or expired. Delete ~/.config/github-copilot/hosts.json and re-authenticate.',
        );
      }
      throw new Error(`Copilot token exchange failed: ${res.status} — ${errorText.slice(0, 200)}`);
    }

    const data = await res.json();
    this.sessionToken = data.token;
    this.sessionExpiresAt = data.expires_at;
    const expiresIn = Math.round(data.expires_at - Date.now() / 1000);
    log('info', `✅ Copilot session token refreshed (expires in ${expiresIn}s)`);
    return this.sessionToken;
  }

  /**
   * Get max output tokens based on model.
   * Copilot supports a wider range of models than GitHub Models,
   * including Claude variants which allow higher output limits.
   * @returns {number} Max output tokens
   */
  getMaxTokens() {
    const base = MERGE_CONFIG.OPENAI_MAX_OUTPUT_TOKENS;
    if (this.model.includes('claude') || this.model.includes('gpt-4o') || this.model.includes('gpt-4.1')) {
      return base * 2; // 16K for high-capacity models
    }
    return base;
  }

  /**
   * Generate response with retry logic and auto token refresh.
   * @param {string} prompt - User prompt
   * @param {string|null} systemInstruction - System instruction
   * @returns {Promise<object>} Parsed JSON response
   */
  async generate(prompt, systemInstruction = null) {
    const messages = this.buildMessages(prompt, systemInstruction);
    const maxRetries = MERGE_CONFIG.CONNECTION_MAX_RETRIES;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const token = await this.getSessionToken();

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'Copilot-Integration-Id': 'vscode-chat',
            'editor-version': 'vscode/1.104.0',
            'editor-plugin-version': 'copilot-chat/0.26.0',
            'user-agent': 'GitHubCopilotChat/0.26.0',
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: 0.2,
            max_tokens: this.getMaxTokens(),
            stream: false,
          }),
        });

        const retryAction = await this.handleErrorStatus(response, attempt, maxRetries);
        if (retryAction === 'retry') continue;

        const data = await response.json();
        const usage = data.usage || {};
        RUN_STATS.trackRequest('copilot', this.model, usage.prompt_tokens || 0, usage.completion_tokens || 0);

        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error('Empty response from Copilot');
        return this.parseJsonResponse(text);
      } catch (err) {
        if (attempt < maxRetries && this.isRetryableError(err)) {
          const delay = MERGE_CONFIG.CONNECTION_BASE_DELAY_MS * attempt;
          log('warn', `⚠️ Copilot connection error, retrying in ${delay}ms: ${err.message.slice(0, 50)}...`);
          await this.sleep(delay);
          continue;
        }
        throw err;
      }
    }

    throw new Error(`Copilot generate failed after ${maxRetries} retries`);
  }

  /**
   * Handle HTTP error statuses from the Copilot API response.
   * @param {globalThis.Response} response - Fetch response
   * @param {number} attempt - Current attempt number
   * @param {number} maxRetries - Maximum retry count
   * @returns {Promise<'retry'|'ok'>} 'retry' to continue loop, 'ok' to proceed
   * @throws {Error} If non-retryable error or retries exhausted
   * @private
   */
  async handleErrorStatus(response, attempt, maxRetries) {
    if (response.status === 401) {
      this.sessionToken = null;
      if (attempt < maxRetries) {
        log('warn', '🔄 Copilot session expired mid-request, refreshing...');
        return 'retry';
      }
    }

    if (response.status === 429) {
      const errorText = await response.text();
      const waitMatch = errorText.match(/(\d{1,10}) ?(?:seconds|s)\b/i);
      const waitSec = waitMatch ? parseInt(waitMatch[1]) : 30;
      if (attempt < maxRetries) {
        log('warn', `⏳ Copilot rate limited, waiting ${waitSec}s (attempt ${attempt}/${maxRetries})...`);
        await this.sleep((waitSec + 5) * 1000);
        return 'retry';
      }
      throw new Error(`Copilot rate limit exceeded after ${maxRetries} retries`);
    }

    if (this.isServerError(response.status)) {
      if (attempt < maxRetries) {
        const delay = MERGE_CONFIG.CONNECTION_BASE_DELAY_MS * attempt;
        log('warn', `⚠️ Copilot server error (${response.status}), retrying in ${delay}ms...`);
        await this.sleep(delay);
        return 'retry';
      }
      throw new Error(`Copilot server error after ${maxRetries} retries: ${response.status}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Copilot API error: ${response.status} — ${errorText.slice(0, 200)}`);
    }

    return 'ok';
  }

  /**
   * Batch processing (same as GitHubModelsClient).
   * @param {Array<{pageNumber: number, blocks: Array}>} pages - Pages to process
   * @param {string} systemInstruction - System instruction
   * @param {Function} promptGenerator - Prompt generator function
   * @returns {Promise<Array<object>>} Per-page results
   */
  async generateBatch(pages, systemInstruction, promptGenerator) {
    const prompt = promptGenerator(pages);
    const result = await this.generate(prompt, systemInstruction);
    return result.results && Array.isArray(result.results) ? result.results : [result];
  }
}

/**
 * Initialize Copilot client with OAuth token.
 * Attempts to load stored token, falls back to device flow.
 * @param {string} model - Model to use
 * @returns {Promise<CopilotClient>} Initialized client
 */
export async function initCopilotClient(model) {
  // Priority: env var > stored token > device flow
  let oauthToken = process.env.COPILOT_TOKEN;

  if (!oauthToken) {
    oauthToken = loadCopilotOAuthToken();
  }

  if (!oauthToken) {
    log('info', '🔐 No Copilot token found — starting OAuth device flow...');
    oauthToken = await copilotDeviceFlow();
    saveCopilotOAuthToken(oauthToken);
  }

  const client = new CopilotClient(oauthToken, model);
  // Validate token by getting initial session token
  await client.getSessionToken();
  return client;
}

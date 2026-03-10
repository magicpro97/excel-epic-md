/**
 * @module run-stats
 * Run statistics tracker — collects LLM usage, timing, and page outcomes.
 * Extracted from scripts/synthesize.mjs.
 */

import fs from 'fs';
import path from 'path';
import { estimateCost } from '../config/pricing.mjs';
import { log } from '../utils/logger.mjs';

/**
 * Global run statistics collector.
 * Tracks LLM requests, token usage, page processing outcomes, and timing.
 * Provides quality scoring and cost estimation for run reports.
 */
export class RunStats {
  constructor() {
    /** @type {number} Unix timestamp (ms) when the run started */
    this.startTime = Date.now();

    /**
     * Per-provider stats keyed by `${provider}::${model}`.
     * @type {Map<string, {provider: string, model: string, requests: number, promptTokens: number, completionTokens: number, costUsd: number}>}
     */
    this.perModel = new Map();

    /** @type {{ total: number, success: number, error: number, cached: number, empty: number, visionRetried: number, byType: {[key: string]: number} }} */
    this.pageStats = {
      total: 0,
      success: 0,
      error: 0,
      cached: 0,
      empty: 0,
      visionRetried: 0,
      byType: {},
    };
  }

  /**
   * Record one LLM API call with its token usage.
   * @param {string} provider - Provider name (e.g. 'gemini', 'github-models')
   * @param {string} model - Model identifier string
   * @param {number} [promptTokens] - Input token count
   * @param {number} [completionTokens] - Output token count
   */
  trackRequest(provider, model, promptTokens = 0, completionTokens = 0) {
    const key = `${provider}::${model}`;
    const existing = this.perModel.get(key) || {
      provider,
      model,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
    };
    existing.requests += 1;
    existing.promptTokens += promptTokens;
    existing.completionTokens += completionTokens;
    existing.costUsd += estimateCost(provider, model, promptTokens, completionTokens);
    this.perModel.set(key, existing);
  }

  /**
   * Record a processed page outcome.
   * @param {string} pageType - pageType field from page summary (e.g. 'requirement', 'error', 'empty')
   * @param {'success'|'error'|'cached'} outcome - Processing outcome category
   */
  trackPage(pageType, outcome) {
    if (outcome === 'cached') {
      this.pageStats.cached++;
    } else if (outcome === 'error') {
      this.pageStats.error++;
    } else {
      this.pageStats.success++;
    }
    if (pageType && pageType !== 'error') {
      this.pageStats.byType[pageType] = (this.pageStats.byType[pageType] || 0) + 1;
    }
  }

  /**
   * Get aggregated totals across all providers.
   * @returns {{ requests: number, promptTokens: number, completionTokens: number, totalTokens: number, costUsd: number }} Aggregated totals
   */
  getTotals() {
    let requests = 0,
      promptTokens = 0,
      completionTokens = 0,
      costUsd = 0;
    for (const e of this.perModel.values()) {
      requests += e.requests;
      promptTokens += e.promptTokens;
      completionTokens += e.completionTokens;
      costUsd += e.costUsd;
    }
    return { requests, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, costUsd };
  }

  /**
   * Get elapsed time in milliseconds since run start.
   * @returns {number} Elapsed milliseconds
   */
  elapsedMs() {
    return Date.now() - this.startTime;
  }

  /**
   * Generate a structured run report object with all collected stats.
   * @returns {object} Run report with timing, tokens, cost, pages, and per-model breakdown
   */
  generateReport() {
    const totals = this.getTotals();
    const elapsed = this.elapsedMs();
    const elapsedSec = (elapsed / 1000).toFixed(1);
    const elapsedMin = (elapsed / 60000).toFixed(1);

    // Per-model breakdown sorted by requests descending
    const perModelBreakdown = [...this.perModel.values()]
      .sort((a, b) => b.requests - a.requests)
      .map((m) => ({
        provider: m.provider,
        model: m.model,
        requests: m.requests,
        promptTokens: m.promptTokens,
        completionTokens: m.completionTokens,
        totalTokens: m.promptTokens + m.completionTokens,
        costUsd: parseFloat(m.costUsd.toFixed(4)),
      }));

    // Tokens per second (throughput)
    const tokensPerSecond = elapsed > 0 ? Math.round(totals.totalTokens / (elapsed / 1000)) : 0;

    // Average tokens per request
    const avgTokensPerRequest = totals.requests > 0 ? Math.round(totals.totalTokens / totals.requests) : 0;

    return {
      timing: {
        startedAt: new Date(this.startTime).toISOString(),
        completedAt: new Date().toISOString(),
        elapsedMs: elapsed,
        elapsedSeconds: parseFloat(elapsedSec),
        elapsedMinutes: parseFloat(elapsedMin),
      },
      tokens: {
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        totalTokens: totals.totalTokens,
        tokensPerSecond,
        avgTokensPerRequest,
      },
      cost: {
        totalUsd: parseFloat(totals.costUsd.toFixed(4)),
        breakdown: perModelBreakdown.filter((m) => m.costUsd > 0),
      },
      requests: {
        total: totals.requests,
        byModel: perModelBreakdown,
      },
      pages: {
        total: this.pageStats.total || this.pageStats.success + this.pageStats.error + this.pageStats.cached,
        success: this.pageStats.success,
        error: this.pageStats.error,
        cached: this.pageStats.cached,
        empty: this.pageStats.empty,
        visionRetried: this.pageStats.visionRetried,
        byType: this.pageStats.byType,
      },
    };
  }
}

/**
 * Print a formatted run report to console and log file.
 * @param {object} report - Report object from RunStats.generateReport()
 * @param {string} [outputDir] - If provided, also saves report as JSON file
 */
export function printRunReport(report, outputDir = null) {
  const lines = [
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║                     📊 RUN REPORT                          ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    `⏱️  Duration: ${report.timing.elapsedSeconds}s (${report.timing.elapsedMinutes} min)`,
    '',
    '── Tokens ──────────────────────────────────────────────────────',
    `   Prompt:     ${report.tokens.promptTokens.toLocaleString()} tokens`,
    `   Completion: ${report.tokens.completionTokens.toLocaleString()} tokens`,
    `   Total:      ${report.tokens.totalTokens.toLocaleString()} tokens`,
    `   Throughput: ${report.tokens.tokensPerSecond.toLocaleString()} tok/s`,
    `   Avg/req:    ${report.tokens.avgTokensPerRequest.toLocaleString()} tokens`,
    '',
    '── Cost ────────────────────────────────────────────────────────',
    `   Total: $${report.cost.totalUsd.toFixed(4)} USD`,
  ];

  if (report.cost.breakdown.length > 0) {
    for (const item of report.cost.breakdown) {
      lines.push(`     ├─ ${item.provider}/${item.model}: $${item.costUsd.toFixed(4)}`);
    }
  }

  lines.push(
    '',
    '── Requests ────────────────────────────────────────────────────',
    `   Total: ${report.requests.total}`,
  );
  for (const item of report.requests.byModel) {
    lines.push(
      `     ├─ ${item.provider}/${item.model}: ${item.requests} reqs (${item.totalTokens.toLocaleString()} tok)`,
    );
  }

  lines.push(
    '',
    '── Pages ───────────────────────────────────────────────────────',
    `   Success: ${report.pages.success}  |  Error: ${report.pages.error}  |  Cached: ${report.pages.cached}`,
    `   Empty: ${report.pages.empty}  |  Vision retried: ${report.pages.visionRetried}`,
  );

  const typeEntries = Object.entries(report.pages.byType);
  if (typeEntries.length > 0) {
    lines.push('   Page types:');
    for (const [type, count] of typeEntries.sort((a, b) => b[1] - a[1])) {
      lines.push(`     ├─ ${type}: ${count}`);
    }
  }

  lines.push('');

  // Print to console
  for (const line of lines) {
    log('info', line);
  }

  // Save report JSON
  if (outputDir) {
    const reportPath = path.join(outputDir, 'llm', 'run_report.json');
    try {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      log('info', `📄 Run report saved: ${reportPath}`);
    } catch (err) {
      log('warn', `⚠️ Failed to save run report: ${err.message}`);
    }
  }
}

/** Global singleton run stats — populated by all LLM clients and pipeline steps. */
export const RUN_STATS = new RunStats();

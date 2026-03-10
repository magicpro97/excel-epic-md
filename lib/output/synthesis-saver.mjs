/**
 * @module synthesis-saver
 * Saves synthesis results to disk — writes epic_synthesis.json and updates manifest.
 * Extracted from scripts/synthesize.mjs.
 */

import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.mjs';
import { RUN_STATS } from '../stats/run-stats.mjs';
import { validateEvidence } from '../validation/evidence-validator.mjs';

function saveSynthesisResults(synthesis, llmDir, outputDir, stats, allPages = null, pageSummaries = null) {
  // For evidence coverage validation, check per-page summaries (Pass 1)
  // because the merge step intentionally removes evidence IDs
  let validationTarget = synthesis;
  if (pageSummaries && pageSummaries.length > 0) {
    // Build a temporary object containing all per-page evidence references
    validationTarget = {
      ...synthesis,
      _pageSummaries: pageSummaries,
    };
  }
  const validation = validateEvidence(validationTarget, allPages);

  // Log validation issues
  if (validation.issues.length > 0) {
    log('warn', 'Validation warnings:');
    validation.issues.forEach((i) => log('warn', `  - ${i}`));
  }

  // Log validation flags
  if (validation.flags.length > 0) {
    for (const flag of validation.flags) {
      log(flag.level, `[VALIDATION] ${flag.message}`);
    }
  }

  // Log completeness metrics
  if (validation.completeness) {
    log(
      'info',
      `📊 OCR Coverage: ${validation.completeness.percentage}% (${validation.completeness.usedCount}/${validation.completeness.totalCount} evidence IDs used)`,
    );
  }

  // Add validation results to synthesis
  synthesis._validation = {
    issues: validation.issues,
    flags: validation.flags,
    completeness: validation.completeness,
    hallucinated: validation.referenceValidation?.hallucinated || [],
  };

  const synthesisPath = path.join(llmDir, 'epic_synthesis.json');
  fs.writeFileSync(synthesisPath, JSON.stringify(synthesis, null, 2));
  log('info', '✅ Epic synthesis complete');

  const manifestPath = path.join(outputDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const runReport = RUN_STATS.generateReport();
    manifest.llm = {
      provider: stats.providerName,
      model: stats.model,
      mergeProvider: stats.mergeProvider || stats.providerName,
      mergeModel: stats.mergeModel || stats.model,
      totalPages: stats.totalPages,
      successPages: stats.successCount,
      errorPages: stats.errorCount,
      cachedPages: stats.cachedCount,
      completedAt: new Date().toISOString(),
      // Run report data
      totalRequests: runReport.requests.total,
      totalTokens: runReport.tokens.totalTokens,
      promptTokens: runReport.tokens.promptTokens,
      completionTokens: runReport.tokens.completionTokens,
      costUsd: runReport.cost.totalUsd,
      elapsedSeconds: runReport.timing.elapsedSeconds,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
}

export { saveSynthesisResults };

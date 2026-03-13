#!/usr/bin/env bun
/**
 * Synthesize epic requirement from OCR output using LLM API
 *
 * Strategy: 2-pass synthesis
 *   Pass 1 — Per-page extraction (individual or batch)
 *   Pass 2 — Hierarchical merge with adaptive chunking
 *
 * Thin entry point — all logic lives in ../lib/
 */

import fs from 'fs';
import path from 'path';

// Config & utilities
import { CONFIG } from '../lib/config/config.mjs';
import { refreshPricing } from '../lib/config/pricing.mjs';
import { RUN_STATS, printRunReport } from '../lib/stats/run-stats.mjs';
import { parseArgs } from '../lib/utils/helpers.mjs';
import { closeFileLogging, initFileLogging, log } from '../lib/utils/logger.mjs';

// LLM clients
import { createLLMClient, createMergeClient } from '../lib/llm-clients/client-factory.mjs';
import { GitHubModelsClient } from '../lib/llm-clients/github-models-client.mjs';

// Data loaders
import { preparePageCache } from '../lib/loaders/cache-loader.mjs';
import { loadOcrFiles } from '../lib/loaders/ocr-loader.mjs';
import { loadOoxmlData } from '../lib/loaders/ooxml-loader.mjs';

// Processing pipeline
import { processBatchPages } from '../lib/processing/batch-processor.mjs';
import { processIndividualPages } from '../lib/processing/page-processor.mjs';
import { retryEmptyPagesWithVision } from '../lib/processing/vision-retry.mjs';

// Merge & post-processing
import { mergeSynthesis } from '../lib/merge/merge-synthesis.mjs';
import { saveSynthesisResults } from '../lib/output/synthesis-saver.mjs';
import { reconcileTables } from '../lib/tables/table-reconciler.mjs';

async function main() {
  const args = parseArgs();

  if (!args.output) {
    console.error('Usage: node synthesize.mjs --output <outputDir> [--force] [--merge-only]');
    process.exit(1);
  }

  const outputDir = path.resolve(args.output);
  const ocrDir = path.join(outputDir, 'ocr');
  const llmDir = path.join(outputDir, 'llm');
  const summariesDir = path.join(llmDir, 'page_summaries');

  // Validate OCR directory
  if (!fs.existsSync(ocrDir)) {
    console.error(`❌ OCR directory not found: ${ocrDir}`);
    process.exit(1);
  }

  // Create output directories
  fs.mkdirSync(llmDir, { recursive: true });
  fs.mkdirSync(summariesDir, { recursive: true });

  // Initialize file logging for debugging
  initFileLogging(outputDir);

  // Clear chunk cache when --force is used (prevents stale merge results)
  const chunkCachePath = path.join(llmDir, 'chunk_results.json');
  if (args.force && fs.existsSync(chunkCachePath)) {
    log('info', '🗑️  --force: clearing chunk_results.json cache');
    fs.unlinkSync(chunkCachePath);
  }

  // Fetch latest model pricing (for accurate cost tracking in run report)
  await refreshPricing();

  // Initialize LLM client
  const client = await createLLMClient();
  const providerName = process.env.LLM_PROVIDER || 'gemini';
  log('info', `Using LLM provider: ${providerName} (model: ${client.model})`);
  log('debug', 'Config:', CONFIG);

  // Load OCR files
  const allPages = loadOcrFiles(ocrDir);

  // Load OOXML data (from extract-ooxml stage)
  const ooxmlData = loadOoxmlData(path.dirname(ocrDir));

  // --merge-only: skip page processing, load all cached summaries directly
  if (args.mergeOnly) {
    log('info', '⏩ --merge-only: skipping page processing, loading cached summaries...');
    const summaryFiles = fs
      .readdirSync(summariesDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    if (summaryFiles.length === 0) {
      log('error', '❌ No cached page summaries found. Run without --merge-only first.');
      await closeFileLogging();
      process.exit(1);
    }
    const pageSummaries = summaryFiles.map((f) => {
      return JSON.parse(fs.readFileSync(path.join(summariesDir, f), 'utf-8'));
    });
    pageSummaries.sort((a, b) => a.pageNumber - b.pageNumber);
    log('info', `📄 Loaded ${pageSummaries.length} cached page summaries`);

    // Jump directly to merge
    await runMerge(client, providerName, pageSummaries, allPages, llmDir, ocrDir, outputDir, 0);
    await closeFileLogging();
    return;
  }

  // Prepare cache and pages to process (OOXML-aware invalidation)
  const { pageSummaries, pagesToProcess, cachedCount } = preparePageCache(
    allPages,
    summariesDir,
    args.force,
    ooxmlData,
    path.dirname(ocrDir),
  );

  // Process pages if any remain
  if (pagesToProcess.length > 0) {
    const supportsBatch = client instanceof GitHubModelsClient;
    const newResults = supportsBatch
      ? await processBatchPages(client, pagesToProcess, summariesDir)
      : await processIndividualPages(client, pagesToProcess, ocrDir, summariesDir, ooxmlData);
    pageSummaries.push(...newResults);
  }

  // Vision retry: re-process any 'empty' pages using Gemini Vision
  await retryEmptyPagesWithVision(pageSummaries, summariesDir, outputDir);

  // Sort summaries by page number
  pageSummaries.sort((a, b) => a.pageNumber - b.pageNumber);

  // Calculate stats
  const successCount = pageSummaries.filter((p) => p.pageType !== 'error').length;
  const errorCount = pageSummaries.filter((p) => p.pageType === 'error').length;
  const errorPages = pageSummaries.filter((p) => p.pageType === 'error').map((p) => p.pageNumber);
  log('info', `\n📊 Pass 1 complete: ${successCount} success, ${errorCount} errors, ${cachedCount} cached`);

  // ABORT if any page failed
  if (errorCount > 0) {
    log('error', `\n❌ ABORT: ${errorCount} page(s) failed extraction: [${errorPages.join(', ')}]`);
    log('error', '   Merging with missing pages would produce incomplete/unreliable output.');
    log('error', '   Fix the errors above (check network/API quota) and re-run.');
    log('error', '   Tip: Successfully extracted pages are cached - only failed pages will be re-processed.');
    const runReport = RUN_STATS.generateReport();
    printRunReport(runReport, outputDir);
    await closeFileLogging();
    process.exit(1);
  }

  // Pass 2: Merge synthesis
  await runMerge(client, providerName, pageSummaries, allPages, llmDir, ocrDir, outputDir, cachedCount);
  await closeFileLogging();
}

/**
 * Run merge synthesis (Pass 2): chunk → merge → reconcile → save
 */
async function runMerge(client, providerName, pageSummaries, allPages, llmDir, ocrDir, outputDir, cachedCount) {
  log('info', '\n🔄 Running merge synthesis...');

  const { client: mergeClient, provider: mergeProvider, model: mergeModel } = await createMergeClient();
  const effectiveMergeClient = mergeClient || client;
  const effectiveMergeProvider = mergeProvider || providerName;
  const effectiveMergeModel = mergeModel || client.model;

  if (mergeClient) {
    log('info', `🔀 Using separate merge client: ${mergeProvider} (${mergeModel})`);
  }

  const successCount = pageSummaries.filter((p) => p.pageType !== 'error').length;
  const errorCount = pageSummaries.filter((p) => p.pageType === 'error').length;

  try {
    const synthesis = await mergeSynthesis(effectiveMergeClient, pageSummaries, llmDir);

    await reconcileTables(synthesis, pageSummaries, ocrDir);

    saveSynthesisResults(
      synthesis,
      llmDir,
      outputDir,
      {
        providerName,
        model: client.model,
        mergeProvider: effectiveMergeProvider,
        mergeModel: effectiveMergeModel,
        totalPages: pageSummaries.length,
        successCount,
        errorCount,
        cachedCount,
      },
      allPages,
      pageSummaries,
    );

    const runReport = RUN_STATS.generateReport();
    printRunReport(runReport, outputDir);
  } catch (err) {
    log('error', `Merge synthesis failed: ${err.message}`);
    const runReport = RUN_STATS.generateReport();
    printRunReport(runReport, outputDir);
    throw err;
  }
}

main().catch(async (err) => {
  console.error(`❌ Synthesize failed: ${err.message}`);
  await closeFileLogging();
  process.exit(1);
});

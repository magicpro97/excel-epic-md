import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config/config.mjs';
import { log } from '../utils/logger.mjs';
import { RUN_STATS } from '../stats/run-stats.mjs';
import { savePageCache } from '../utils/cache.mjs';
import { sleep } from '../utils/helpers.mjs';
import { pageExtractionPrompt, visionPagePrompt } from '../prompts/page-prompts.mjs';
import { SYSTEM_INSTRUCTION } from '../prompts/system-instruction.mjs';
import { formatOoxmlForPrompt } from '../loaders/ooxml-loader.mjs';
import { generateWithFallback } from './fallback.mjs';
import { GeminiClient } from '../llm-clients/gemini-client.mjs';

/**
 * Process a single page with OCR data
 * @param {GeminiClient} client - Gemini API client
 * @param {number} pageNumber - Page number
 * @param {{ blocks: Array<object>, tables?: Array<object> }} ocrData - OCR data for the page
 * @param {string|null} renderPagesDir - Path to render/pages/ dir for vision fallback
 * @param {GeminiClient|null} visionClient - Dedicated vision client (Gemini) for 0-block pages
 * @param {object|null} ooxmlSheet - OOXML data for this page's sheet (from loadOoxmlData)
 * @returns {Promise<object>} Extracted page information
 */
async function processPage(client, pageNumber, ocrData, renderPagesDir = null, visionClient = null, ooxmlSheet = null) {
  log('debug', `🧠 Analyzing page ${pageNumber}...`);

  const ooxmlSection = formatOoxmlForPrompt(ooxmlSheet);
  const hasOoxmlShapes = (ooxmlSheet?.shapes?.length || 0) > 0;

  if (!ocrData.blocks || ocrData.blocks.length === 0) {
    // If OOXML has shapes but OCR found nothing, use OOXML + vision combo
    if (hasOoxmlShapes) {
      log('info', `📦 Page ${pageNumber}: 0 OCR blocks but ${ooxmlSheet.shapes.length} OOXML shapes → using OOXML data`);
      const prompt = pageExtractionPrompt(pageNumber, [], [], ocrData.sheetName, ooxmlSection);
      const { result } = await generateWithFallback(client, prompt, SYSTEM_INSTRUCTION, { estimatedOutputTokens: 1000, pageCount: 1 });
      return result;
    }

    // Vision fallback: send PNG directly to Gemini when OCR found nothing
    // This handles sheets with embedded UI screenshots/mockups
    const usableVisionClient = visionClient || (typeof client.generateVision === 'function' ? client : null);
    if (renderPagesDir && usableVisionClient) {
      const imagePath = path.join(renderPagesDir, `page-${String(pageNumber).padStart(4, '0')}.png`);
      if (fs.existsSync(imagePath)) {
        try {
          log('info', `🖼️  Page ${pageNumber}: 0 OCR blocks → using Vision fallback`);
          const prompt = visionPagePrompt(pageNumber);
          const result = await usableVisionClient.generateVision(imagePath, prompt, SYSTEM_INSTRUCTION);
          log('info', `✅ Page ${pageNumber} analyzed via Vision`);
          return result;
        } catch (err) {
          log('warn', `⚠️  Vision fallback failed for page ${pageNumber}: ${err.message.slice(0, 80)}`);
        }
      }
    }
    log('debug', `⚠️  Page ${pageNumber} has no text blocks (skipped)`);
    return {
      pageNumber,
      pageType: 'empty',
      extractedInfo: {},
      ambiguousTexts: [],
      openQuestions: [],
    };
  }

  const tables = ocrData.tables || [];
  if (tables.length > 0) {
    log('info', `📊 Page ${pageNumber}: ${tables.length} table(s) detected by img2table`);
  }

  const sheetName = ocrData.sheetName || null;
  if (sheetName) {
    log('debug', `📋 Page ${pageNumber}: sheet context = "${sheetName}"`);
  }

  const prompt = pageExtractionPrompt(pageNumber, ocrData.blocks, tables, sheetName, ooxmlSection);

  if (hasOoxmlShapes) {
    log('info', `📦 Page ${pageNumber}: injecting ${ooxmlSheet.shapes.length} OOXML shapes into prompt`);
  }

  // Phase 3 Fix: Use generateWithFallback for per-page processing
  // This provides OpenRouter fallback when Gemini socket disconnects
  // Estimate ~1000 output tokens per page (conservative)
  const options = {
    estimatedOutputTokens: 1000,
    pageCount: 1,
  };

  const { result, usedFallback } = await generateWithFallback(client, prompt, SYSTEM_INSTRUCTION, options);

  if (usedFallback) {
    log('info', `🔄 Page ${pageNumber} processed via OpenRouter fallback`);
  }

  return result;
}

/**
 * Process pages individually (non-GitHub providers)
 * @param {BaseLLMClient} client - LLM client
 * @param {Array} pagesToProcess - Pages to process
 * @param {string} ocrDir - Path to OCR directory
 * @param {string} summariesDir - Path to summaries directory
 * @returns {Promise<Array>} Page summaries
 */
async function processIndividualPages(client, pagesToProcess, ocrDir, summariesDir, ooxmlData = new Map()) {
  const concurrency = CONFIG.pageConcurrency;
  log('info', `📝 Using per-page processing (concurrency: ${concurrency})`);
  const results = [];
  // Derive render/pages/ dir from ocrDir (sibling directory)
  const renderPagesDir = path.join(path.dirname(ocrDir), 'render', 'pages');

  // Vision client: use main client if it supports vision (Gemini), otherwise
  // create a dedicated GeminiClient for vision-only fallback on 0-block pages
  let visionClient = typeof client.generateVision === 'function' ? client : null;
  if (!visionClient) {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      visionClient = new GeminiClient(geminiKey, geminiModel);
      log('info', '🖼️  Vision fallback client: Gemini (for 0-block pages)');
    }
  }

  // Build pageNumber → sheetIndex map from manifest for OOXML lookup
  const pageToSheetIndex = new Map();
  if (ooxmlData.size > 0) {
    const manifestPath = path.join(path.dirname(ocrDir), 'manifest.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (Array.isArray(manifest.sheets)) {
        for (const sheet of manifest.sheets) {
          if (sheet.sheetIndex && Array.isArray(sheet.sourcePages)) {
            for (const pageNum of sheet.sourcePages) {
              pageToSheetIndex.set(pageNum, sheet.sheetIndex);
            }
          }
        }
      }
    } catch { /* manifest read failed — no OOXML mapping */ }
  }

  // Process pages in parallel batches with concurrency limit
  for (let i = 0; i < pagesToProcess.length; i += concurrency) {
    const batch = pagesToProcess.slice(i, i + concurrency);
    const batchLabel = batch.map((p) => p.pageNumber).join(', ');
    log(
      'info',
      `🚀 Processing batch [${batchLabel}] (${Math.min(i + concurrency, pagesToProcess.length)}/${pagesToProcess.length})`,
    );

    const batchPromises = batch.map(async (page) => {
      const { pageNumber } = page;
      const ocrPath = path.join(ocrDir, page.ocrFile);
      const ocrData = JSON.parse(fs.readFileSync(ocrPath, 'utf-8'));

      // Inject sheetName from loadOcrFiles() (includes manifest lookup) if not in OCR file
      if (!ocrData.sheetName && page.sheetName) {
        ocrData.sheetName = page.sheetName;
      }

      try {
        const sheetIdx = pageToSheetIndex.get(pageNumber);
        const ooxmlSheet = sheetIdx != null ? ooxmlData.get(sheetIdx) || null : null;
        const hadOoxml = (ooxmlSheet?.shapes?.length || 0) > 0;
        const summary = await processPage(client, pageNumber, ocrData, renderPagesDir, visionClient, ooxmlSheet);
        savePageCache(summariesDir, pageNumber, summary, hadOoxml);
        RUN_STATS.trackPage(summary.pageType, summary.pageType === 'error' ? 'error' : 'success');
        if (summary.pageType === 'empty') RUN_STATS.pageStats.empty++;
        log('info', `✅ Page ${pageNumber} analyzed`);
        return summary;
      } catch (err) {
        log('error', `Page ${pageNumber} failed: ${err.message}`);
        RUN_STATS.trackPage('error', 'error');
        const errorSummary = {
          pageNumber,
          pageType: 'error',
          error: err.message,
          extractedInfo: {},
          ambiguousTexts: [],
          openQuestions: [`Error: ${err.message}`],
        };
        savePageCache(summariesDir, pageNumber, errorSummary);
        return errorSummary;
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Delay between batches to respect rate limits (skip after last batch)
    if (i + concurrency < pagesToProcess.length) {
      await sleep(CONFIG.requestDelayMs);
    }
  }

  return results;
}

/**
 * Collect all tables from page summaries (deterministic, no LLM dependency)
 * This ensures tables extracted per-page are never lost during merge.
 * @param {Array<object>} pageSummaries - Per-page summary objects from LLM
 * @returns {Array<{title: string, markdownTable: string, notes?: string}>} Collected tables
 */
function collectTablesFromPageSummaries(pageSummaries) {
  const tables = [];
  for (const page of pageSummaries) {
    const pageTables = page?.extractedInfo?.tables || [];
    for (const t of pageTables) {
      if (t.markdownTable || t.title) {
        tables.push({
          title: t.title || `Table (page ${page.pageNumber})`,
          markdownTable: t.markdownTable || '',
          notes: t.notes || null,
          pageNumber: page.pageNumber,
        });
      }
    }
  }
  return tables;
}

export { processPage, processIndividualPages, collectTablesFromPageSummaries };

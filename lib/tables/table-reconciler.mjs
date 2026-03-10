import path from 'path';
import { log } from '../utils/logger.mjs';
import { collectTablesFromPageSummaries } from '../processing/page-processor.mjs';
import { buildPageToSheetMap } from '../loaders/ocr-loader.mjs';
import { enrichTableTitles } from './table-enrichment.mjs';
import { flagBrokenTables } from './table-validation.mjs';
import { correctOcrTruncation } from './ocr-correction.mjs';
import { reExtractMisalignedTables } from './vision-reextractor.mjs';

/**
 * Normalize table title for dedup comparison — strip EV-ID suffixes and whitespace
 * @param {string} title - Table title
 * @returns {string} Normalized title for comparison
 */
function normalizeTitle(title) {
  if (!title) return '';
  return title
    .replace(/\s*\[EV-[^\]]+\]\s*/g, '') // strip [EV-pNNNN-tNNNN] suffixes
    .replace(/\s*-\s*Trang\s+\d+/g, '') // strip "- Trang N" page suffixes
    .trim()
    .toLowerCase();
}

/**
 * Deduplicate tables by normalized title, keeping the richer version
 * @param {Array<object>} tables - Tables to deduplicate
 * @returns {Array<object>} Deduplicated tables
 */
function deduplicateTablesByTitle(tables) {
  const seen = new Map();
  for (const table of tables) {
    const key = normalizeTitle(table.title);
    if (!key) {
      seen.set(Symbol(), table); // keep untitled tables
      continue;
    }
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, table);
    } else {
      // Keep the version with more content (longer markdownTable)
      const existingLen = existing.markdownTable?.length || 0;
      const newLen = table.markdownTable?.length || 0;
      if (newLen > existingLen) {
        seen.set(key, table);
      }
    }
  }
  return [...seen.values()];
}

/**
 * Reconcile tables from merge LLM output and page summaries, then enrich/validate.
 * @param {object} synthesis - Merged synthesis result (mutated in place)
 * @param {Array<object>} pageSummaries - Per-page summaries
 * @param {string|null} [ocrDir] - Path to OCR directory for sheet-name fallback
 * @returns {Promise<void>}
 */
async function reconcileTables(synthesis, pageSummaries, ocrDir = null) {
  const mergedTables = synthesis.tables || [];
  const pageTables = collectTablesFromPageSummaries(pageSummaries);

  if (pageTables.length > 0 && mergedTables.length === 0) {
    log('info', `📊 Injecting ${pageTables.length} tables from page summaries (merge LLM returned 0)`);
    synthesis.tables = pageTables;
  } else if (pageTables.length > mergedTables.length) {
    log('info', `📊 Supplementing tables: merge has ${mergedTables.length}, pages have ${pageTables.length}`);
    const existingTitles = new Set(mergedTables.map((t) => normalizeTitle(t.title)));
    const newTables = pageTables.filter((t) => !existingTitles.has(normalizeTitle(t.title)));
    synthesis.tables = [...mergedTables, ...newTables];
  }

  // Deduplicate tables by normalized title (handles EV-ID suffix variants)
  if (synthesis.tables?.length > 0) {
    const before = synthesis.tables.length;
    synthesis.tables = deduplicateTablesByTitle(synthesis.tables);
    if (synthesis.tables.length < before) {
      log('info', `📊 Deduplicated tables: ${before} → ${synthesis.tables.length} (removed ${before - synthesis.tables.length} duplicates)`);
    }
  }

  // Build page-to-sheet map for sheetName fallback on table titles
  const pageToSheet = ocrDir ? buildPageToSheetMap(ocrDir) : new Map();

  // Enrich table titles with entity context and flag broken tables
  if (synthesis.tables?.length > 0) {
    enrichTableTitles(synthesis.tables, pageToSheet);
    flagBrokenTables(synthesis.tables);

    // Vision re-extraction for misaligned tables (#3)
    if (ocrDir) {
      const outputDir = path.dirname(ocrDir);
      await reExtractMisalignedTables(synthesis.tables, outputDir);
    }

    // Apply OCR text correction dictionary to all table content
    correctOcrTruncation(synthesis.tables);
    log('info', `📊 Final output: ${synthesis.tables.length} specification tables`);
  }
}

export { reconcileTables };

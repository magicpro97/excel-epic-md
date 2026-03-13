import fs from 'fs';
import path from 'path';
import { checkPageCache } from '../utils/cache.mjs';
import { log } from '../utils/logger.mjs';
import { buildOoxmlByName, sheetHasOoxmlData } from './ooxml-loader.mjs';

/**
 * Build pageNumber → sheetName map from manifest.
 * Uses sheet NAME (not index) to avoid mismatch between manifest and OOXML numbering.
 * @param {string} outputDir - Output directory containing manifest.json
 * @returns {Map<number, string>} pageNumber → sheetName
 */
function buildPageToSheetNameMap(outputDir) {
  const map = new Map();
  const manifestPath = path.join(outputDir, 'manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (Array.isArray(manifest.sheets)) {
      for (const sheet of manifest.sheets) {
        if (sheet.sheetName && Array.isArray(sheet.sourcePages)) {
          for (const pageNum of sheet.sourcePages) {
            map.set(pageNum, sheet.sheetName);
          }
        }
      }
    }
  } catch {
    /* manifest not available */
  }
  return map;
}

/**
 * Check if a page's sheet has OOXML data (shapes OR cells).
 * Uses name-based matching to handle index mismatches.
 * @param {number} pageNumber - Page number
 * @param {Map<number, string>} pageToSheetNameMap - pageNumber → sheetName
 * @param {Map<string, object>} ooxmlByName - sheetName → merged OOXML data
 * @returns {boolean}
 */
function pageHasOoxmlData(pageNumber, pageToSheetNameMap, ooxmlByName) {
  const sheetName = pageToSheetNameMap.get(pageNumber);
  if (!sheetName) return false;
  return sheetHasOoxmlData(ooxmlByName.get(sheetName));
}

/**
 * Prepare page cache — decides which pages need (re-)processing
 * @param {Array} allPages - All OCR pages
 * @param {string} summariesDir - Path to summaries directory
 * @param {boolean} force - Force reprocess all pages
 * @param {Map<number, object>} [ooxmlData] - OOXML data per sheet (for cache invalidation)
 * @param {string} [outputDir] - Output directory (for manifest lookup)
 * @returns {{ pageSummaries: Array, pagesToProcess: Array, cachedCount: number }}
 */
function preparePageCache(allPages, summariesDir, force, ooxmlData = new Map(), outputDir = '') {
  const pageSummaries = [];
  const pagesToProcess = [];
  let cachedCount = 0;
  let ooxmlInvalidated = 0;

  const ooxmlByName = ooxmlData.size > 0 ? buildOoxmlByName(ooxmlData) : new Map();
  const pageToSheetNameMap = ooxmlData.size > 0 && outputDir ? buildPageToSheetNameMap(outputDir) : new Map();

  for (const page of allPages) {
    const cache = checkPageCache(summariesDir, page.pageNumber);
    if (cache.cached && !force) {
      // Invalidate cache if OOXML data exists but page was processed without it
      const hasData = pageHasOoxmlData(page.pageNumber, pageToSheetNameMap, ooxmlByName);
      if (hasData && !cache.data.hadOoxml) {
        log('info', `🔄 Page ${page.pageNumber}: OOXML data available but cache lacks OOXML → re-processing`);
        pagesToProcess.push(page);
        ooxmlInvalidated++;
        continue;
      }
      pageSummaries.push(cache.data);
      cachedCount++;
    } else {
      pagesToProcess.push(page);
    }
  }

  if (cachedCount > 0) {
    log('info', `📦 Resuming: ${cachedCount} pages cached, ${pagesToProcess.length} pages to process`);
  }
  if (ooxmlInvalidated > 0) {
    log('info', `📦 OOXML cache invalidation: ${ooxmlInvalidated} page(s) will be re-processed with OOXML data`);
  }

  return { pageSummaries, pagesToProcess, cachedCount };
}

function loadCachedChunkResults(chunkResultsFile, expectedChunks) {
  if (!chunkResultsFile || !fs.existsSync(chunkResultsFile)) {
    return { chunkResults: [], startIndex: 0 };
  }

  try {
    const cached = JSON.parse(fs.readFileSync(chunkResultsFile, 'utf-8'));
    if (cached.chunks && cached.totalChunks === expectedChunks) {
      log('info', `📦 Resuming merge: ${cached.chunks.length}/${expectedChunks} chunks already processed`);
      return { chunkResults: cached.chunks, startIndex: cached.chunks.length };
    }
  } catch {
    log('warn', 'Could not load chunk cache, starting fresh');
  }
  return { chunkResults: [], startIndex: 0 };
}

export { loadCachedChunkResults, preparePageCache };

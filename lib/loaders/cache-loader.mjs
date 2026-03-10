import fs from 'fs';
import path from 'path';
import { checkPageCache } from '../utils/cache.mjs';
import { log } from '../utils/logger.mjs';

/**
 * Build pageNumber → sheetIndex map from manifest
 * @param {string} outputDir - Output directory containing manifest.json
 * @returns {Map<number, number>} pageNumber → sheetIndex
 */
function buildPageToSheetMap(outputDir) {
  const map = new Map();
  const manifestPath = path.join(outputDir, 'manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (Array.isArray(manifest.sheets)) {
      for (const sheet of manifest.sheets) {
        if (sheet.sheetIndex && Array.isArray(sheet.sourcePages)) {
          for (const pageNum of sheet.sourcePages) {
            map.set(pageNum, sheet.sheetIndex);
          }
        }
      }
    }
  } catch { /* manifest not available */ }
  return map;
}

/**
 * Check if a page's sheet has OOXML shapes
 * @param {number} pageNumber - Page number
 * @param {Map<number, number>} pageToSheetMap - pageNumber → sheetIndex
 * @param {Map<number, object>} ooxmlData - sheetIndex → OOXML data
 * @returns {boolean}
 */
function pageHasOoxmlShapes(pageNumber, pageToSheetMap, ooxmlData) {
  const sheetIdx = pageToSheetMap.get(pageNumber);
  if (sheetIdx == null) return false;
  const sheet = ooxmlData.get(sheetIdx);
  return (sheet?.shapes?.length || 0) > 0;
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

  const pageToSheetMap = ooxmlData.size > 0 && outputDir
    ? buildPageToSheetMap(outputDir)
    : new Map();

  for (const page of allPages) {
    const cache = checkPageCache(summariesDir, page.pageNumber);
    if (cache.cached && !force) {
      // Invalidate cache if OOXML shapes exist but page was processed without them
      const hasShapes = pageHasOoxmlShapes(page.pageNumber, pageToSheetMap, ooxmlData);
      if (hasShapes && !cache.data.hadOoxml) {
        log('info', `🔄 Page ${page.pageNumber}: OOXML shapes available but cache lacks OOXML → re-processing`);
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

export { preparePageCache, loadCachedChunkResults };

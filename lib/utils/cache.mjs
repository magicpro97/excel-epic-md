/**
 * @module cache
 * Cache/resume utilities for page processing.
 * Extracted from scripts/synthesize.mjs.
 */

import fs from 'fs';
import path from 'path';
import { CACHE_VERSION } from '../config/config.mjs';
import { log } from './logger.mjs';

/**
 * Check if page is already cached
 * @param {string} summariesDir - Path to summaries directory
 * @param {number} pageNumber - Page number
 * @returns {{ cached: boolean, data: object | null }} Cache status
 */
export function checkPageCache(summariesDir, pageNumber) {
  const summaryPath = path.join(summariesDir, `page-${String(pageNumber).padStart(4, '0')}.json`);
  if (fs.existsSync(summaryPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
      // Valid cache must have: pageNumber, not be an error, and matching cache version
      const versionMatch = data.cacheVersion === CACHE_VERSION;
      if (data.pageNumber === pageNumber && data.pageType !== 'error' && versionMatch) {
        return { cached: true, data };
      }
      if (!versionMatch && data.pageNumber === pageNumber) {
        log('debug', `Cache version mismatch for page ${pageNumber}: ${data.cacheVersion} !== ${CACHE_VERSION}`);
      }
    } catch {
      // Corrupted cache, will reprocess
    }
  }
  return { cached: false, data: null };
}

/**
 * Save page summary to cache
 * @param {string} summariesDir - Path to summaries directory
 * @param {number} pageNumber - Page number
 * @param {object} summary - Page summary data
 * @param {boolean} [hadOoxml=false] - Whether OOXML shapes were injected into the prompt
 */
export function savePageCache(summariesDir, pageNumber, summary, hadOoxml = false) {
  const summaryPath = path.join(summariesDir, `page-${String(pageNumber).padStart(4, '0')}.json`);
  const summaryWithVersion = { ...summary, cacheVersion: CACHE_VERSION, hadOoxml };
  fs.writeFileSync(summaryPath, JSON.stringify(summaryWithVersion, null, 2));
}

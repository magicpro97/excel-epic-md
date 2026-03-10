import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.mjs';

function buildPageToSheetMap(ocrDir) {
  const manifestPath = path.join(path.dirname(ocrDir), 'manifest.json');
  /** @type {Map<number, string>} */
  const pageToSheet = new Map();

  if (!fs.existsSync(manifestPath)) return pageToSheet;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    // Method 1: Use sheets[] array with sourcePages (from render step with stitching)
    if (Array.isArray(manifest.sheets) && manifest.sheets.length > 0) {
      for (const sheet of manifest.sheets) {
        if (sheet.sheetName && Array.isArray(sheet.sourcePages)) {
          for (const pageNum of sheet.sourcePages) {
            pageToSheet.set(pageNum, sheet.sheetName);
          }
        }
      }
      if (pageToSheet.size > 0) {
        log('info', `📋 Loaded sheet context for ${pageToSheet.size} pages from manifest (sheets[])`);
        return pageToSheet;
      }
    }

    // Method 2: Use render.sheetNames + totalPages to infer mapping (fallback)
    const sheetNames = manifest.render?.sheetNames || [];
    const totalPages = manifest.render?.totalPages || manifest.pages?.length || 0;
    if (sheetNames.length > 0 && totalPages > 0) {
      const pagesPerSheet = Math.ceil(totalPages / sheetNames.length);
      for (let i = 0; i < sheetNames.length; i++) {
        const startPage = i * pagesPerSheet + 1;
        const endPage = Math.min((i + 1) * pagesPerSheet, totalPages);
        for (let p = startPage; p <= endPage; p++) {
          pageToSheet.set(p, sheetNames[i]);
        }
      }
      if (pageToSheet.size > 0) {
        log('info', `📋 Inferred sheet context for ${pageToSheet.size} pages from manifest (avgPagesPerSheet)`);
      }
    }
  } catch (err) {
    log('warn', `⚠️ Failed to read manifest for sheet context: ${err.message}`);
  }

  return pageToSheet;
}

/**
 * Load all OCR files from directory
 * @param {string} ocrDir - Path to OCR directory
 * @returns {Array<{pageNumber: number, blocks: Array, ocrFile: string, sheetName: string|null}>} Array of page data
 */
function loadOcrFiles(ocrDir) {
  // Build page→sheet mapping from manifest for context injection
  const pageToSheet = buildPageToSheetMap(ocrDir);

  // Prefer sheet-based OCR files over page-based
  let ocrFiles = fs
    .readdirSync(ocrDir)
    .filter((f) => f.match(/^sheet-\d+\.json$/))
    .sort();

  let mode = 'sheet';

  if (ocrFiles.length === 0) {
    ocrFiles = fs
      .readdirSync(ocrDir)
      .filter((f) => f.match(/^page-\d+\.json$/))
      .sort();
    mode = 'page';
  }

  if (ocrFiles.length === 0) {
    throw new Error(`No OCR files found in ${ocrDir}`);
  }

  log('info', `Found ${ocrFiles.length} ${mode}s to synthesize`);

  return ocrFiles.map((ocrFile) => {
    const ocrPath = path.join(ocrDir, ocrFile);
    const ocrData = JSON.parse(fs.readFileSync(ocrPath, 'utf-8'));

    // Normalize blocks: ensure evidenceId exists (backward compat with older OCR)
    const blocks = (ocrData.blocks || []).map((b, idx) => {
      const pagePrefix =
        mode === 'sheet' ? `s${String(ocrData.page).padStart(2, '0')}` : `p${String(ocrData.page).padStart(4, '0')}`;
      const blockId = String(b.id || idx + 1).padStart(4, '0');
      const defaultEvidenceId = `EV-${pagePrefix}-b${blockId}`;

      return {
        ...b,
        evidenceId: b.evidenceId || defaultEvidenceId,
      };
    });

    // Inject sheetName: prefer OCR-embedded value, fall back to manifest mapping
    const sheetName = ocrData.sheetName || pageToSheet.get(ocrData.page) || null;

    return {
      pageNumber: ocrData.page,
      sheetName,
      blocks,
      tables: ocrData.tables || [],
      ocrFile,
    };
  });
}

export { buildPageToSheetMap, loadOcrFiles };

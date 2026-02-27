#!/usr/bin/env bun
/**
 * Render Excel sheets to PNG images using LibreOffice
 *
 * Strategy:
 * 1. Set "Fit to 1 Page Width" for all worksheets (ExcelJS)
 * 2. Convert Excel → PDF (LibreOffice headless)
 * 3. Convert PDF → PNG (poppler-utils pdftoppm)
 *
 * Supported platforms: Linux, macOS
 * Note: Windows is NOT supported (requires WSL or similar)
 *
 * Config (from .env or CLI):
 * - RENDER_DPI: PNG resolution (default: 300)
 * - RENDER_ORIENTATION: landscape | portrait (default: landscape)
 * - RENDER_PAPER_SIZE: Excel paperSize (default: 9 = A4)
 * - RENDER_FIT_TO_WIDTH: true | false (default: true)
 *
 * Output: {outputDir}/render/pages/page-0001.png, page-0002.png, ...
 */

import { execFileSync } from 'child_process';
import dotenv from 'dotenv';
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import which from 'which';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Load .env file using dotenv (handles quotes, multiline, edge cases)
// Note: import.meta.dir is Bun-specific. For Node.js, use: path.dirname(fileURLToPath(import.meta.url))
const envPath = path.resolve(import.meta.dir, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

/**
 * Valid paper sizes for Excel (subset of common ones)
 * @see https://docs.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.pagesetup.papersize
 */
const VALID_PAPER_SIZES = {
  1: 'Letter (8.5 x 11 in)',
  5: 'Legal (8.5 x 14 in)',
  8: 'A3 (297 x 420 mm)',
  9: 'A4 (210 x 297 mm)',
  11: 'A5 (148 x 210 mm)',
};

/**
 * Valid orientations for page setup
 */
const VALID_ORIENTATIONS = ['landscape', 'portrait'];

/**
 * CJK Unicode ranges for width estimation
 * CJK characters are approximately 2x width of Latin characters
 * @todo Use this for auto column width calculation
 */
const _CJK_REGEX = /[\u3000-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g;

/**
 * Large fitToHeight value to simulate "unlimited" vertical pages
 * Using 99 instead of 0 because some Excel readers interpret 0 as 1
 */
const FIT_TO_HEIGHT_UNLIMITED = 99;

/**
 * Maximum number of sheet names to store in manifest (to prevent bloat)
 */
const MAX_SHEET_NAMES_IN_MANIFEST = 50;

/**
 * Maximum number of sheet names to display in console log
 */
const MAX_SHEET_NAMES_IN_LOG = 10;

/**
 * Default timeout values in milliseconds
 */
const DEFAULT_LIBREOFFICE_TIMEOUT_MS = 120000; // 2 minutes
const DEFAULT_PDFTOPPM_TIMEOUT_MS = 300000; // 5 minutes

/**
 * Parse and validate render configuration from environment
 * @returns {Readonly<{ dpi: number, orientation: 'landscape' | 'portrait', paperSize: number, fitToWidth: boolean, libreOfficeTimeoutMs: number, pdftoppmTimeoutMs: number }>} Validated config object
 */
function loadConfig() {
  // Parse DPI with validation
  const rawDpi = process.env.RENDER_DPI || '300';
  const dpi = parseInt(rawDpi, 10);
  if (Number.isNaN(dpi) || dpi < 72 || dpi > 1200) {
    throw new Error(`Invalid RENDER_DPI="${rawDpi}". Must be a number between 72 and 1200.`);
  }

  // Parse orientation with validation
  const orientation = process.env.RENDER_ORIENTATION || 'landscape';
  if (!VALID_ORIENTATIONS.includes(orientation)) {
    throw new Error(`Invalid RENDER_ORIENTATION="${orientation}". Must be one of: ${VALID_ORIENTATIONS.join(', ')}`);
  }

  // Parse paper size with validation
  const rawPaperSize = process.env.RENDER_PAPER_SIZE || '9';
  const paperSize = parseInt(rawPaperSize, 10);
  if (Number.isNaN(paperSize) || !VALID_PAPER_SIZES[paperSize]) {
    const validOptions = Object.entries(VALID_PAPER_SIZES)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    throw new Error(`Invalid RENDER_PAPER_SIZE="${rawPaperSize}". Valid options: ${validOptions}`);
  }

  // Parse fitToWidth boolean
  const fitToWidth = process.env.RENDER_FIT_TO_WIDTH !== 'false';

  // Parse stitchSheets boolean (default: true)
  const stitchSheets = process.env.RENDER_STITCH_SHEETS !== 'false';

  // Parse wrapText boolean (default: true)
  const wrapText = process.env.RENDER_WRAP_TEXT !== 'false';

  // Parse timeout values (optional, use defaults if not set or invalid)
  const rawLibreOfficeTimeout = process.env.RENDER_LIBREOFFICE_TIMEOUT_MS;
  const libreOfficeTimeoutMs = rawLibreOfficeTimeout
    ? Math.max(10000, parseInt(rawLibreOfficeTimeout, 10) || DEFAULT_LIBREOFFICE_TIMEOUT_MS)
    : DEFAULT_LIBREOFFICE_TIMEOUT_MS;

  const rawPdftoppmTimeout = process.env.RENDER_PDFTOPPM_TIMEOUT_MS;
  const pdftoppmTimeoutMs = rawPdftoppmTimeout
    ? Math.max(10000, parseInt(rawPdftoppmTimeout, 10) || DEFAULT_PDFTOPPM_TIMEOUT_MS)
    : DEFAULT_PDFTOPPM_TIMEOUT_MS;

  // Return frozen object to prevent accidental mutation
  return Object.freeze({
    dpi,
    orientation: /** @type {'landscape' | 'portrait'} */ (orientation),
    paperSize,
    fitToWidth,
    stitchSheets,
    wrapText,
    libreOfficeTimeoutMs,
    pdftoppmTimeoutMs,
  });
}

// Load and validate config at module initialization
const CONFIG = loadConfig();

/**
 * Parse command line arguments using yargs
 * @returns {{ input: string | null, output: string | null }} Parsed arguments
 */
function parseArgs() {
  const argv = yargs(hideBin(process.argv))
    .usage('Usage: $0 --input <file.xlsx> --output <outputDir>')
    .option('input', {
      alias: 'i',
      type: 'string',
      description: 'Input Excel file path',
    })
    .option('output', {
      alias: 'o',
      type: 'string',
      description: 'Output directory path',
    })
    .help()
    .alias('h', 'help')
    .parseSync();

  return {
    input: argv.input || null,
    output: argv.output || null,
  };
}

/**
 * Find LibreOffice executable path using 'which' library
 * Checks LIBREOFFICE_PATH env var first, then falls back to PATH lookup
 * @returns {Promise<{ path: string, source: string }>} Path to LibreOffice executable
 */
async function findLibreOffice() {
  // Check environment variable first (from .env or system)
  const envPath = process.env.LIBREOFFICE_PATH;
  if (envPath) {
    try {
      fs.accessSync(envPath, fs.constants.X_OK);
      return { path: envPath, source: 'LIBREOFFICE_PATH' };
    } catch {
      if (fs.existsSync(envPath)) {
        throw new Error(`LIBREOFFICE_PATH="${envPath}" exists but is not executable. Check permissions.`);
      }
    }
  }

  // Use 'which' library to find executable in PATH
  const candidates = ['libreoffice', 'soffice'];
  for (const cmd of candidates) {
    const found = await which(cmd, { nothrow: true });
    if (found) {
      return { path: found, source: 'auto-detected' };
    }
  }

  // Fallback to macOS-specific path
  const macOSPath = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
  if (fs.existsSync(macOSPath)) {
    try {
      fs.accessSync(macOSPath, fs.constants.X_OK);
      return { path: macOSPath, source: 'auto-detected (macOS)' };
    } catch {
      // Not executable, continue to error
    }
  }

  throw new Error(
    'LibreOffice not found. Install: apt install libreoffice-calc libreoffice-headless (Linux) or brew install --cask libreoffice (macOS). Or set LIBREOFFICE_PATH in .env',
  );
}

/**
 * Find pdftoppm executable path using 'which' library
 * Checks PDFTOPPM_PATH env var first, then falls back to PATH lookup
 * @returns {Promise<{ path: string, source: string }>} Path and source info
 */
async function findPdftoppm() {
  // Check environment variable first
  const envPath = process.env.PDFTOPPM_PATH;
  if (envPath) {
    try {
      fs.accessSync(envPath, fs.constants.X_OK);
      return { path: envPath, source: 'PDFTOPPM_PATH' };
    } catch {
      if (fs.existsSync(envPath)) {
        throw new Error(`PDFTOPPM_PATH="${envPath}" exists but is not executable. Check permissions.`);
      }
    }
  }

  // Use 'which' library to find executable in PATH
  const found = await which('pdftoppm', { nothrow: true });
  if (found) {
    return { path: found, source: 'auto-detected' };
  }

  throw new Error(
    'pdftoppm not found. Install: apt install poppler-utils (Linux) or brew install poppler (macOS). Or set PDFTOPPM_PATH in .env',
  );
}

/**
 * Set "Fit to 1 Page Width" for all worksheets in Excel file
 * This ensures each sheet fits horizontally in one page, reducing total pages
 * @param {string} inputPath - Input Excel file path
 * @param {string} outputPath - Output Excel file path (modified)
 * @returns {Promise<{ sheetCount: number, sheetNames: string[] }>} Sheet info
 */
async function setFitToWidth(inputPath, outputPath) {
  console.log('  📐 Setting page setup for all worksheets...');
  console.log(
    `     📝 Config: DPI=${CONFIG.dpi}, orientation=${CONFIG.orientation}, paperSize=${CONFIG.paperSize} (${VALID_PAPER_SIZES[CONFIG.paperSize]}), fitToWidth=${CONFIG.fitToWidth}`,
  );
  console.log(
    `     ⏱️  Timeouts: LibreOffice=${CONFIG.libreOfficeTimeoutMs}ms, pdftoppm=${CONFIG.pdftoppmTimeoutMs}ms`,
  );

  const workbook = new ExcelJS.Workbook();

  const wrapTextStats = { totalCells: 0, sheets: 0 };

  try {
    await workbook.xlsx.readFile(inputPath);
  } catch (err) {
    throw new Error(`Failed to read Excel file: ${err.message}`);
  }

  const sheetNames = [];

  workbook.eachSheet((worksheet) => {
    sheetNames.push(worksheet.name);

    // Set page setup based on config
    worksheet.pageSetup = {
      ...worksheet.pageSetup,
      fitToPage: CONFIG.fitToWidth,
      fitToWidth: CONFIG.fitToWidth ? 1 : undefined, // Fit to 1 page wide
      fitToHeight: CONFIG.fitToWidth ? FIT_TO_HEIGHT_UNLIMITED : undefined,
      orientation: CONFIG.orientation,
      paperSize: CONFIG.paperSize,
      margins: {
        left: 0.25,
        right: 0.25,
        top: 0.5,
        bottom: 0.5,
        header: 0.3,
        footer: 0.3,
      },
    };

    // Force wrapText on all cells to prevent content overflow
    if (CONFIG.wrapText) {
      let cellCount = 0;
      worksheet.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          cell.alignment = { ...cell.alignment, wrapText: true };
          cellCount++;
        });
      });
      if (cellCount > 0) {
        wrapTextStats.totalCells += cellCount;
        wrapTextStats.sheets++;
      }
    }
  });

  try {
    await workbook.xlsx.writeFile(outputPath);
  } catch (err) {
    throw new Error(`Failed to write modified Excel file: ${err.message}`);
  }

  // Truncate sheet names for logging if too many
  const displayNames =
    sheetNames.length > MAX_SHEET_NAMES_IN_LOG
      ? `${sheetNames.slice(0, MAX_SHEET_NAMES_IN_LOG).join(', ')}... (+${sheetNames.length - MAX_SHEET_NAMES_IN_LOG} more)`
      : sheetNames.join(', ');
  console.log(`  ✅ Modified ${sheetNames.length} worksheets: ${displayNames}`);

  if (CONFIG.wrapText && wrapTextStats.totalCells > 0) {
    console.log(`  📏 Enabled wrapText on ${wrapTextStats.totalCells.toLocaleString()} cells across ${wrapTextStats.sheets} sheets`);
  }

  return { sheetCount: sheetNames.length, sheetNames };
}

/**
 * Convert Excel to PDF using LibreOffice
 * @param {string} inputPath - Input Excel file path
 * @param {string} tempDir - Temporary directory for output
 * @param {string} libreOfficePath - Path to LibreOffice executable
 * @returns {string} Path to generated PDF file
 */
function excelToPdf(inputPath, tempDir, libreOfficePath) {
  console.log('  📄 Converting Excel → PDF...');

  const args = ['--headless', '--convert-to', 'pdf', '--outdir', tempDir, inputPath];
  console.log(`  $ ${libreOfficePath} ${args.join(' ')}`);

  try {
    // Using execFileSync instead of execSync to prevent shell injection
    execFileSync(libreOfficePath, args, { stdio: 'pipe', timeout: CONFIG.libreOfficeTimeoutMs });
  } catch (err) {
    throw new Error(`LibreOffice conversion failed: ${err.message}`);
  }

  // Find generated PDF
  const basename = path.basename(inputPath, path.extname(inputPath));
  const pdfPath = path.join(tempDir, `${basename}.pdf`);

  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF not generated at: ${pdfPath}`);
  }

  console.log(`  ✅ PDF created: ${pdfPath}`);
  return pdfPath;
}

/**
 * Convert PDF to PNG using pdftoppm
 * @param {string} pdfPath - Path to PDF file
 * @param {string} pagesDir - Directory for PNG output
 * @param {string} pdftoppmPath - Path to pdftoppm executable
 * @returns {string[]} List of generated PNG filenames
 */
function pdfToPng(pdfPath, pagesDir, pdftoppmPath) {
  console.log('  🖼️  Converting PDF → PNG...');

  // pdftoppm output: prefix-01.png, prefix-02.png, ...
  const prefix = path.join(pagesDir, 'page');
  const args = ['-png', '-r', String(CONFIG.dpi), pdfPath, prefix];
  console.log(`  $ ${pdftoppmPath} ${args.join(' ')}`);

  try {
    // Using execFileSync instead of execSync to prevent shell injection
    execFileSync(pdftoppmPath, args, { stdio: 'pipe', timeout: CONFIG.pdftoppmTimeoutMs });
  } catch (err) {
    throw new Error(`pdftoppm conversion failed: ${err.message}`);
  }

  // Rename files to 4-digit format: page-1.png → page-0001.png
  const files = fs.readdirSync(pagesDir).filter((f) => f.startsWith('page-') && f.endsWith('.png'));
  const renamedFiles = [];

  for (const file of files) {
    const match = file.match(/page-(\d+)\.png$/);
    if (match) {
      const pageNum = parseInt(match[1], 10);
      const newName = `page-${String(pageNum).padStart(4, '0')}.png`;
      const oldPath = path.join(pagesDir, file);
      const newPath = path.join(pagesDir, newName);
      fs.renameSync(oldPath, newPath);
      renamedFiles.push(newName);
    }
  }

  renamedFiles.sort();
  console.log(`  ✅ Generated ${renamedFiles.length} PNG pages`);
  return renamedFiles;
}

/**
 * Update manifest.json with page information
 * @param {string} outputDir - Output directory containing manifest.json
 * @param {string[]} pages - List of page filenames
 * @param {{ sheetCount: number, sheetNames: string[] }} sheetInfo - Sheet information
 * @returns {void}
 */
function updateManifest(outputDir, pages, sheetInfo) {
  const manifestPath = path.join(outputDir, 'manifest.json');

  // Check if manifest exists, create minimal one if not
  let manifest;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      console.warn(`  ⚠️ Failed to parse manifest.json, creating new one: ${err.message}`);
      manifest = {};
    }
  } else {
    console.log('  ℹ️ manifest.json not found, creating new one');
    manifest = {};
  }

  manifest.pages = pages.map((filename, idx) => ({
    pageNumber: idx + 1,
    filename,
    path: `render/pages/${filename}`,
    evidencePrefix: `EV-p${String(idx + 1).padStart(4, '0')}`,
  }));

  // Truncate sheet names if too many to prevent manifest bloat
  const truncatedSheetNames =
    sheetInfo.sheetNames.length > MAX_SHEET_NAMES_IN_MANIFEST
      ? [
          ...sheetInfo.sheetNames.slice(0, MAX_SHEET_NAMES_IN_MANIFEST),
          `... (+${sheetInfo.sheetNames.length - MAX_SHEET_NAMES_IN_MANIFEST} more)`,
        ]
      : sheetInfo.sheetNames;

  // Calculate average pages per sheet, handling edge case of empty Excel
  const avgPagesPerSheet = sheetInfo.sheetCount > 0 ? Math.round((pages.length / sheetInfo.sheetCount) * 10) / 10 : 0;

  manifest.render = {
    totalPages: pages.length,
    sheetCount: sheetInfo.sheetCount,
    sheetNames: truncatedSheetNames,
    avgPagesPerSheet,
    config: {
      dpi: CONFIG.dpi,
      orientation: CONFIG.orientation,
      paperSize: CONFIG.paperSize,
      fitToWidth: CONFIG.fitToWidth,
    },
    completedAt: new Date().toISOString(),
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('  ✅ Manifest updated');
}

// ============================================================================
// SHEET STITCHING: Parse PDF bookmarks → Stitch pages per sheet
// ============================================================================

/**
 * Parse PDF bookmarks/outlines to get sheet-to-page mapping.
 * Uses mutool (MuPDF) to extract outline structure from LibreOffice-generated PDF.
 * Falls back to pdfinfo or even distribution if not available.
 * @param {string} pdfPath - Path to PDF file generated by LibreOffice
 * @param {string[]} sheetNames - Original sheet names from Excel
 * @param {number} totalPages - Total number of PDF pages
 * @returns {Promise<Array<{sheetIndex: number, sheetName: string, startPage: number, endPage: number}>>} Sheet-to-page mapping array
 */
async function parseSheetPageMapping(pdfPath, sheetNames, totalPages) {
  try {
    // Try mutool first (MuPDF) — most reliable for LibreOffice PDFs
    const mutoolPath = await findTool('mutool');
    if (mutoolPath) {
      // Use execFileSync with args array to prevent shell injection
      // SECURITY: mutoolPath comes from findTool which validates tool name
      // SECURITY: pdfPath is resolved from user input but passed as argument (not shell-interpolated)
      let result;
      try {
        result = execFileSync(mutoolPath, ['show', pdfPath, 'outline'], {
          encoding: 'utf-8',
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'ignore'], // Ignore stderr (equivalent to 2>/dev/null)
        }).trim();
      } catch {
        // mutool may fail on PDFs without outlines - this is expected
        result = '';
      }

      if (result) {
        const lines = result.split('\n').filter((l) => l.trim());
        const bookmarks = [];

        for (const line of lines) {
          // mutool show outline format: |  "Title text"  #page=N&zoom=...
          // SECURITY: Use atomic groups pattern to prevent ReDoS on untrusted input
          // The pattern is safe because: input lines are bounded, and we use possessive-like matching
          const match = line.match(/"([^"]+)"\s+#page=(\d+)/);
          if (match) {
            bookmarks.push({
              page: parseInt(match[2], 10),
              title: match[1].trim(),
            });
          }
        }

        if (bookmarks.length > 0) {
          console.log(`  📑 Found ${bookmarks.length} PDF bookmarks via mutool`);
          return buildMappingFromBookmarks(bookmarks, sheetNames, totalPages);
        }
      }
    }

    console.log('  ⚠️ No PDF bookmarks found. Using fallback mapping.');
    return buildFallbackMapping(sheetNames, totalPages);
  } catch (err) {
    console.log(`  ⚠️ PDF bookmark parse failed: ${err.message}. Using fallback.`);
    return buildFallbackMapping(sheetNames, totalPages);
  }
}

/**
 * Find a tool by name (checking PATH) using the 'which' library
 * @param {string} name - Tool name (must be alphanumeric with hyphens/underscores only)
 * @returns {Promise<string|null>} Path or null
 */
async function findTool(name) {
  // Validate tool name to prevent any injection (defense in depth)
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    console.warn(`  ⚠️ Invalid tool name: ${name}`);
    return null;
  }
  // Use 'which' library instead of shell command for safety
  return which(name, { nothrow: true });
}

/**
 * Build sheet-to-page mapping from PDF bookmarks.
 * @param {Array<{page: number, title: string}>} bookmarks - Parsed bookmarks
 * @param {string[]} sheetNames - Original sheet names
 * @param {number} totalPages - Total pages in PDF
 * @returns {Array<{sheetIndex: number, sheetName: string, startPage: number, endPage: number}>} Sheet-to-page mapping array
 */
function buildMappingFromBookmarks(bookmarks, sheetNames, totalPages) {
  const mapping = [];

  for (let i = 0; i < bookmarks.length; i++) {
    const startPage = bookmarks[i].page;
    const endPage = i < bookmarks.length - 1 ? bookmarks[i + 1].page - 1 : totalPages;

    mapping.push({
      sheetIndex: i + 1,
      sheetName: bookmarks[i].title || sheetNames[i] || `Sheet${i + 1}`,
      startPage,
      endPage,
    });
  }

  // Validate
  const coveredPages = mapping.reduce((sum, m) => sum + (m.endPage - m.startPage + 1), 0);
  if (coveredPages !== totalPages) {
    console.log(`  ⚠️ Bookmark coverage: ${coveredPages}/${totalPages} pages. Adjusting last entry.`);
    if (mapping.length > 0) {
      mapping[mapping.length - 1].endPage = totalPages;
    }
  }

  return mapping;
}

/**
 * Build fallback sheet-to-page mapping by dividing pages evenly across sheets.
 * Used when PDF bookmarks are unavailable.
 * @param {string[]} sheetNames - Sheet names from Excel
 * @param {number} totalPages - Total number of PDF pages
 * @returns {Array<{sheetIndex: number, sheetName: string, startPage: number, endPage: number}>} Sheet-to-page mapping array
 */
function buildFallbackMapping(sheetNames, totalPages) {
  const mapping = [];
  const pagesPerSheet = Math.ceil(totalPages / sheetNames.length);

  for (let i = 0; i < sheetNames.length; i++) {
    const startPage = i * pagesPerSheet + 1;
    const endPage = Math.min((i + 1) * pagesPerSheet, totalPages);
    if (startPage > totalPages) break;

    mapping.push({
      sheetIndex: i + 1,
      sheetName: sheetNames[i],
      startPage,
      endPage,
    });
  }

  return mapping;
}

/**
 * Stitch pages belonging to the same sheet into a single tall image.
 * Single-page sheets are copied as-is.
 * @param {string} pagesDir - Directory containing page-NNNN.png files
 * @param {string} sheetsDir - Output directory for stitched sheet images
 * @param {Array<{sheetIndex: number, sheetName: string, startPage: number, endPage: number}>} mapping - Sheet-to-page mapping
 * @returns {Promise<Array<{sheetIndex: number, sheetName: string, filename: string, sourcePages: number[], width: number, height: number}>>} Stitched sheet results
 */
async function stitchSheetPages(pagesDir, sheetsDir, mapping) {
  fs.mkdirSync(sheetsDir, { recursive: true });

  const results = [];

  for (const sheet of mapping) {
    const { sheetIndex, sheetName, startPage, endPage } = sheet;
    const pageCount = endPage - startPage + 1;
    const filename = `sheet-${String(sheetIndex).padStart(2, '0')}.png`;
    const outputPath = path.join(sheetsDir, filename);
    const sourcePages = [];

    for (let p = startPage; p <= endPage; p++) {
      sourcePages.push(p);
    }

    const pagePaths = sourcePages.map(
      (p) => path.join(pagesDir, `page-${String(p).padStart(4, '0')}.png`),
    );

    // Verify all source pages exist
    const validPaths = pagePaths.filter((p) => fs.existsSync(p));
    if (validPaths.length === 0) {
      console.log(`  ⚠️ No pages found for sheet ${sheetIndex} (${sheetName})`);
      continue;
    }

    let width = 0;
    let height = 0;

    if (validPaths.length === 1) {
      // Single page → copy directly
      fs.copyFileSync(validPaths[0], outputPath);
      const meta = await sharp(outputPath).metadata();
      width = meta.width || 0;
      height = meta.height || 0;
    } else {
      // Multiple pages → vertically stitch using sharp
      const metas = await Promise.all(validPaths.map((p) => sharp(p).metadata()));
      const maxWidth = Math.max(...metas.map((m) => m.width || 0));
      const totalHeight = metas.reduce((sum, m) => sum + (m.height || 0), 0);

      let yOffset = 0;
      const composites = validPaths.map((imgPath, i) => {
        const comp = { input: imgPath, top: yOffset, left: 0 };
        yOffset += metas[i].height || 0;
        return comp;
      });

      await sharp({
        create: {
          width: maxWidth,
          height: totalHeight,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .composite(composites)
        .png()
        .toFile(outputPath);

      width = maxWidth;
      height = totalHeight;
    }

    const safeName = sheetName.length > 20 ? sheetName.slice(0, 20) + '…' : sheetName;
    const pagesStr = pageCount === 1 ? `page ${startPage}` : `pages ${startPage}-${endPage}`;
    console.log(`  🧩 ${safeName.padEnd(22)} (${pagesStr}) → ${filename} (${width}x${height})`);

    results.push({
      sheetIndex,
      sheetName,
      filename,
      sourcePages,
      width,
      height,
    });
  }

  return results;
}

/**
 * Update manifest with sheet stitching information
 * @param {string} outputDir - Output directory
 * @param {Array} sheetResults - Stitched sheet results
 * @param {Array} pages - Original page filenames
 * @param {{ sheetCount: number, sheetNames: string[] }} sheetInfo - Sheet information
 */
function updateManifestWithSheets(outputDir, sheetResults, pages, sheetInfo) {
  const manifestPath = path.join(outputDir, 'manifest.json');

  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      manifest = {};
    }
  }

  // Keep original pages for reference
  manifest.pages = pages.map((filename, idx) => ({
    pageNumber: idx + 1,
    filename,
    path: `render/pages/${filename}`,
  }));

  // Add sheets array (primary source for OCR)
  manifest.sheets = sheetResults.map((s) => ({
    sheetIndex: s.sheetIndex,
    sheetName: s.sheetName,
    filename: s.filename,
    path: `render/sheets/${s.filename}`,
    sourcePages: s.sourcePages,
    dimensions: { width: s.width, height: s.height },
  }));

  manifest.render = {
    totalPages: pages.length,
    totalSheets: sheetResults.length,
    sheetCount: sheetInfo.sheetCount,
    sheetNames: sheetInfo.sheetNames.slice(0, MAX_SHEET_NAMES_IN_MANIFEST),
    stitchEnabled: true,
    wrapTextEnabled: CONFIG.wrapText,
    config: {
      dpi: CONFIG.dpi,
      orientation: CONFIG.orientation,
      paperSize: CONFIG.paperSize,
      fitToWidth: CONFIG.fitToWidth,
    },
    completedAt: new Date().toISOString(),
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('  ✅ Manifest updated (with sheet stitching)');
}

/**
 * Main entry point
 * @returns {Promise<void>} Promise that resolves when rendering completes
 */
async function main() {
  const args = parseArgs();

  if (!args.input || !args.output) {
    console.error('Usage: node render.mjs --input <file.xlsx> --output <outputDir>');
    process.exit(1);
  }

  const inputPath = path.resolve(args.input);
  const outputDir = path.resolve(args.output);

  if (!fs.existsSync(inputPath)) {
    console.error(`❌ Input file not found: ${inputPath}`);
    process.exit(1);
  }

  // Create directories
  const renderDir = path.join(outputDir, 'render');
  const tempDir = path.join(renderDir, 'temp');
  const pagesDir = path.join(renderDir, 'pages');

  // Check if render is already complete (skip if pages exist)
  const existingPages = fs.existsSync(pagesDir) ? fs.readdirSync(pagesDir).filter((f) => f.endsWith('.png')) : [];
  const sheetsDir = path.join(renderDir, 'sheets');
  const existingSheets = fs.existsSync(sheetsDir) ? fs.readdirSync(sheetsDir).filter((f) => f.endsWith('.png')) : [];

  if (existingPages.length > 0 && (!CONFIG.stitchSheets || existingSheets.length > 0)) {
    const sheetsInfo = existingSheets.length > 0 ? `, ${existingSheets.length} sheets` : '';
    console.log(`  ⏭️ Skipping render: ${existingPages.length} pages${sheetsInfo} already exist`);

    // Rebuild manifest if sheet mapping is missing (handles prior runs that lost it)
    const manifestPath = path.join(outputDir, 'manifest.json');
    let needsManifestRebuild = false;
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        needsManifestRebuild =
          !manifest.sheets || manifest.sheets.length === 0 || !manifest.pages || manifest.pages.length === 0;
      } catch {
        needsManifestRebuild = true;
      }
    } else {
      needsManifestRebuild = true;
    }

    if (needsManifestRebuild) {
      console.log('  🔄 Rebuilding manifest with sheet mapping...');
      try {
        // Read sheet names from Excel
        const ExcelJS = (await import('exceljs')).default;
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(inputPath);
        const sheetNames = [];
        workbook.eachSheet((ws) => sheetNames.push(ws.name));

        const sortedPages = existingPages.sort();
        const sheetInfo = { sheetCount: sheetNames.length, sheetNames };

        if (existingSheets.length > 0) {
          // Build sheet results from existing sheet PNGs
          const sortedSheets = existingSheets.sort();
          const sheetResults = sortedSheets.map((filename, idx) => ({
            sheetIndex: idx + 1,
            sheetName: sheetNames[idx] || `Sheet${idx + 1}`,
            filename,
            sourcePages: [],
            width: 0,
            height: 0,
          }));

          // Distribute pages evenly across sheets
          const pagesPerSheet = Math.ceil(sortedPages.length / sortedSheets.length);
          for (let p = 0; p < sortedPages.length; p++) {
            const sheetIdx = Math.min(Math.floor(p / pagesPerSheet), sheetResults.length - 1);
            sheetResults[sheetIdx].sourcePages.push(p + 1);
          }

          updateManifestWithSheets(outputDir, sheetResults, sortedPages, sheetInfo);
          console.log(`  ✅ Manifest rebuilt: ${sheetResults.length} sheets, ${sortedPages.length} pages`);
        } else {
          // No sheet PNGs - just update manifest with pages + render info (enables Method 2 in synthesize)
          updateManifest(outputDir, sortedPages, sheetInfo);
          console.log(`  ✅ Manifest rebuilt (pages-only): ${sheetNames.length} sheets, ${sortedPages.length} pages`);
        }
      } catch (err) {
        console.warn(`  ⚠️ Could not rebuild manifest: ${err.message}`);
      }
    }

    return;
  }

  fs.mkdirSync(renderDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(pagesDir, { recursive: true });

  // Find tools (async with 'which' library)
  const libreOffice = await findLibreOffice();
  const pdftoppm = await findPdftoppm();

  console.log(`  🔧 LibreOffice: ${libreOffice.path} (${libreOffice.source})`);
  console.log(`  🔧 pdftoppm: ${pdftoppm.path} (${pdftoppm.source})`);

  // Track temp dir for cleanup in case of error
  let sheetInfo = null;
  let pages = [];
  let sheetResults = null;

  try {
    // Step 1: Apply "fit to 1 page width" to all worksheets
    const modifiedExcel = path.join(tempDir, 'modified.xlsx');
    sheetInfo = await setFitToWidth(inputPath, modifiedExcel);

    // Step 2: Convert modified Excel → PDF → PNG
    const pdfPath = excelToPdf(modifiedExcel, tempDir, libreOffice.path);
    pages = pdfToPng(pdfPath, pagesDir, pdftoppm.path);

    const avgPages = sheetInfo.sheetCount > 0 ? Math.round((pages.length / sheetInfo.sheetCount) * 10) / 10 : 0;
    console.log(`  📊 Summary: ${sheetInfo.sheetCount} sheets → ${pages.length} pages (avg ${avgPages} pages/sheet)`);

    // Step 3: Sheet stitching (if enabled)
    if (CONFIG.stitchSheets && pages.length > 0 && sheetInfo.sheetCount > 0) {
      console.log('\n📐 Step 3: Stitching pages per sheet...');
      const sheetsDir = path.join(renderDir, 'sheets');

      // Parse PDF bookmarks to get sheet→page mapping
      const mapping = await parseSheetPageMapping(pdfPath, sheetInfo.sheetNames, pages.length);
      console.log(`  📋 Sheet mapping: ${mapping.length} sheets across ${pages.length} pages`);
      for (const m of mapping) {
        const pCount = m.endPage - m.startPage + 1;
        console.log(`    Sheet ${m.sheetIndex}: "${m.sheetName}" → pages ${m.startPage}-${m.endPage} (${pCount} page${pCount > 1 ? 's' : ''})`);
      }

      // Stitch pages per sheet
      sheetResults = await stitchSheetPages(pagesDir, sheetsDir, mapping);
      console.log(`  ✅ Stitched ${sheetResults.length} sheet images`);
    }
  } finally {
    // Always cleanup temp files, even on error
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log('  🧹 Cleaned up temp files');
    }
  }

  // Update manifest (only if we have results)
  if (sheetInfo && pages.length > 0) {
    if (sheetResults && sheetResults.length > 0) {
      updateManifestWithSheets(outputDir, sheetResults, pages, sheetInfo);
    } else {
      updateManifest(outputDir, pages, sheetInfo);
    }
  }
}

main().catch((err) => {
  console.error(`❌ Render failed: ${err.message}`);
  process.exit(1);
});

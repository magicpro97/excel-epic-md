#!/usr/bin/env node
/**
 * extract-ooxml.mjs — Extract shapes, connectors, pictures, and cell values
 * from .xlsx OOXML structure (ZIP + XML) for the excel-epic-md pipeline.
 *
 * Outputs structured JSON per sheet to outputDir/ooxml/
 * Updates manifest.json with ooxml metadata.
 *
 * Usage: bun scripts/extract-ooxml.mjs --input <xlsx> --output <outputDir>
 */

import ExcelJS from 'exceljs';
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

// ─── XML Namespaces ──────────────────────────────────────────────────────────
const NS_DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

// fast-xml-parser config: preserve attributes, handle namespaces
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,
  isArray: (name) => {
    // Elements that can appear multiple times
    const arrayTags = ['xdr:twoCellAnchor', 'xdr:oneCellAnchor', 'xdr:absoluteAnchor', 'a:r', 'a:p', 'Relationship'];
    return arrayTags.includes(name);
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(level, msg) {
  const prefix = { info: '📦', warn: '⚠️', error: '❌', debug: '🔍' }[level] || '';
  console.log(`[extract-ooxml] ${prefix} ${msg}`);
}

/**
 * Classify ARGB color string to semantic name.
 * Japanese spec convention: red = changed/added, blue = reference/note.
 * @param {string|undefined} argb - ARGB hex string (e.g., "FFFF0000")
 * @returns {string|null} 'red' | 'blue' | null
 */
function classifyColor(argb) {
  if (!argb || argb === 'FF000000' || argb === '00000000') return null;
  if (argb === 'FFFF0000' || argb === 'FF0000') return 'red';
  if (argb.includes('0000FF') || argb.includes('0563C1')) return 'blue';
  return null;
}

/**
 * Extract all text from a DrawingML text body (a:txBody).
 * Detects strikethrough in run properties (a:rPr) and wraps with ~~text~~.
 */
function extractTextFromTxBody(txBody) {
  if (!txBody) return '';
  const paragraphs = ensureArray(txBody['a:p']);
  const texts = [];
  for (const p of paragraphs) {
    const runs = ensureArray(p['a:r']);
    for (const r of runs) {
      const t = r?.['a:t'];
      if (t != null) {
        const text = typeof t === 'object' ? (t['#text'] ?? '') : String(t);
        const rPr = r?.['a:rPr'];
        const strike = rPr?.['@_strike'];
        const isStrike = strike === 'sngStrike' || strike === 'dblStrike';
        texts.push(isStrike ? `~~${text}~~` : text);
      }
    }
  }
  return texts.join(' ').trim();
}

/** Get shape preset geometry type */
function getShapeType(sp) {
  const spPr = sp?.['xdr:spPr'] ?? sp?.['spPr'];
  const prstGeom = spPr?.['a:prstGeom'];
  return prstGeom?.['@_prst'] ?? 'unknown';
}

/** Get shape name from non-visual properties */
function getShapeName(sp, nsPrefix = 'xdr') {
  const nvSpPr = sp?.[`${nsPrefix}:nvSpPr`] ?? sp?.['nvSpPr'];
  const cNvPr = nvSpPr?.[`${nsPrefix}:cNvPr`] ?? nvSpPr?.['cNvPr'];
  return cNvPr?.['@_name'] ?? '';
}

/** Extract position from anchor's from/to elements */
function extractPosition(anchor, nsPrefix = 'xdr') {
  const from = anchor?.[`${nsPrefix}:from`] ?? anchor?.['from'];
  const to = anchor?.[`${nsPrefix}:to`] ?? anchor?.['to'];
  const pos = {};
  if (from) {
    pos.fromCol = parseInt(from[`${nsPrefix}:col`] ?? from['col'] ?? '0', 10);
    pos.fromRow = parseInt(from[`${nsPrefix}:row`] ?? from['row'] ?? '0', 10);
  }
  if (to) {
    pos.toCol = parseInt(to[`${nsPrefix}:col`] ?? to['col'] ?? '0', 10);
    pos.toRow = parseInt(to[`${nsPrefix}:row`] ?? to['row'] ?? '0', 10);
  }
  return pos;
}

/** Get picture embed reference */
function getPictureEmbed(pic, nsPrefix = 'xdr') {
  const blipFill = pic?.[`${nsPrefix}:blipFill`] ?? pic?.['blipFill'];
  const blip = blipFill?.['a:blip'];
  return blip?.['@_r:embed'] ?? null;
}

function ensureArray(val) {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

// ─── Core OOXML Extraction ───────────────────────────────────────────────────

/**
 * Parse sheet-to-drawing relationships from the ZIP.
 * Returns Map<sheetIndex, drawingPath>
 */
async function parseSheetDrawingMap(zip) {
  const map = new Map();

  // Find all sheet rels files (not all sheets have rels)
  const sheetRelsFiles = Object.keys(zip.files)
    .filter((f) => /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(f))
    .sort();

  for (const relsPath of sheetRelsFiles) {
    const sheetNum = parseInt(relsPath.match(/sheet(\d+)/)[1], 10);
    const relsFile = zip.file(relsPath);
    if (!relsFile) continue;

    const relsXml = await relsFile.async('string');
    const parsed = xmlParser.parse(relsXml);
    const rels = ensureArray(parsed?.Relationships?.Relationship);

    for (const rel of rels) {
      const type = rel?.['@_Type'] ?? '';
      if (type.includes('/drawing')) {
        const target = rel['@_Target'];
        // Target is relative: ../drawings/drawing1.xml
        const drawingPath = target.startsWith('..') ? `xl/${target.replace('../', '')}` : `xl/drawings/${target}`;
        map.set(sheetNum, drawingPath);
      }
    }
  }
  return map;
}

/**
 * Parse drawing-to-media relationships.
 * Returns Map<rId, mediaPath>
 */
async function parseDrawingMediaMap(zip, drawingPath) {
  const map = new Map();
  const drawingDir = path.dirname(drawingPath);
  const relsPath = `${drawingDir}/_rels/${path.basename(drawingPath)}.rels`;
  const relsFile = zip.file(relsPath);
  if (!relsFile) return map;

  const relsXml = await relsFile.async('string');
  const parsed = xmlParser.parse(relsXml);
  const rels = ensureArray(parsed?.Relationships?.Relationship);

  for (const rel of rels) {
    const type = rel?.['@_Type'] ?? '';
    if (type.includes('/image')) {
      const rId = rel['@_Id'];
      const target = rel['@_Target'];
      const mediaPath = target.startsWith('..') ? `xl/${target.replace('../', '')}` : `${drawingDir}/${target}`;
      map.set(rId, mediaPath);
    }
  }
  return map;
}

/**
 * Extract shapes, connectors, and pictures from a single drawing XML.
 */
async function extractDrawing(zip, drawingPath) {
  const drawingFile = zip.file(drawingPath);
  if (!drawingFile) return { shapes: [], connectors: [], pictures: [] };

  const xml = await drawingFile.async('string');
  const parsed = xmlParser.parse(xml);

  // Drawing root is xdr:wsDr
  const root = parsed?.['xdr:wsDr'] ?? parsed?.['wsDr'] ?? parsed;
  const shapes = [];
  const connectors = [];
  const pictures = [];

  const mediaMap = await parseDrawingMediaMap(zip, drawingPath);

  // Process twoCellAnchor elements (most common)
  const anchors = [...ensureArray(root?.['xdr:twoCellAnchor']), ...ensureArray(root?.['xdr:oneCellAnchor'])];

  for (const anchor of anchors) {
    const pos = extractPosition(anchor);

    // Shape (xdr:sp)
    const sp = anchor?.['xdr:sp'];
    if (sp) {
      const txBody = sp?.['xdr:txBody'] ?? sp?.['txBody'];
      const text = extractTextFromTxBody(txBody);
      shapes.push({
        type: getShapeType(sp),
        name: getShapeName(sp),
        text,
        hasText: text.length > 0,
        position: pos,
      });
    }

    // Connector (xdr:cxnSp)
    const cxn = anchor?.['xdr:cxnSp'];
    if (cxn) {
      const cxnSpPr = cxn?.['xdr:spPr'] ?? cxn?.['spPr'];
      const prstGeom = cxnSpPr?.['a:prstGeom'];
      connectors.push({
        type: prstGeom?.['@_prst'] ?? 'unknown',
        position: pos,
      });
    }

    // Picture (xdr:pic)
    const pic = anchor?.['xdr:pic'];
    if (pic) {
      const rId = getPictureEmbed(pic);
      pictures.push({
        rId,
        mediaPath: rId ? (mediaMap.get(rId) ?? null) : null,
        position: pos,
      });
    }
  }

  return { shapes, connectors, pictures };
}

// ─── Cell Value Extraction ───────────────────────────────────────────────────

/**
 * Read cell values directly via ExcelJS.
 * Returns array of { address, value, merged, formula } per sheet.
 */
async function extractCellValues(xlsxPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);

  const sheetsData = [];
  workbook.eachSheet((ws, sheetId) => {
    const cells = [];
    const mergedRanges = [];

    // Collect merged cell ranges
    if (ws.model?.merges) {
      for (const merge of ws.model.merges) {
        mergedRanges.push(merge);
      }
    }

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const value = cell.value;
        if (value == null) return;

        // Determine display value
        let displayValue;
        if (typeof value === 'object') {
          if (value.richText) {
            displayValue = value.richText.map((rt) => rt.text).join('');
          } else if (value.formula) {
            displayValue = value.result != null ? String(value.result) : `=${value.formula}`;
          } else if (value.hyperlink) {
            displayValue = value.text ?? value.hyperlink;
          } else {
            displayValue = String(value);
          }
        } else {
          displayValue = String(value);
        }

        if (!displayValue || displayValue === 'undefined') return;

        const address = cell.address ?? `${String.fromCharCode(64 + colNumber)}${rowNumber}`;
        const isMerged = mergedRanges.some((r) => r.includes(address));

        // Extract formatting metadata (strikethrough, color)
        const formatting = {};
        const font = cell.font || {};

        if (font.strike) formatting.strike = true;
        const cellColor = classifyColor(font.color?.argb);
        if (cellColor) formatting.color = cellColor;

        // RichText per-run formatting (partial strikethrough, mixed colors)
        if (value.richText) {
          const hasRunFormatting = value.richText.some((rt) => {
            const f = rt.font || {};
            return f.strike || classifyColor(f.color?.argb);
          });
          if (hasRunFormatting) {
            formatting.richText = value.richText.map((rt) => {
              const f = rt.font || {};
              const flags = [];
              if (f.strike) flags.push('strike');
              const c = classifyColor(f.color?.argb);
              if (c) flags.push(c);
              return { text: rt.text, flags };
            });
          }
        }

        const cellData = {
          address,
          row: rowNumber,
          col: colNumber,
          value: displayValue,
          merged: isMerged,
        };

        if (Object.keys(formatting).length > 0) {
          cellData.formatting = formatting;
        }

        cells.push(cellData);
      });
    });

    sheetsData.push({
      sheetIndex: sheetId,
      sheetName: ws.name,
      cells,
      mergedRanges,
    });
  });

  return sheetsData;
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────

async function extractOoxml(xlsxPath, outputDir) {
  const ooxmlDir = path.join(outputDir, 'ooxml');
  fs.mkdirSync(ooxmlDir, { recursive: true });

  // ── Step 1: Detect file type ──
  let zipBuffer;
  try {
    zipBuffer = fs.readFileSync(xlsxPath);
    // Check ZIP magic bytes (PK\x03\x04)
    if (zipBuffer[0] !== 0x50 || zipBuffer[1] !== 0x4b) {
      log('warn', `Not a ZIP file (possibly .xls format). Skipping OOXML extraction.`);
      writeEmptyOutput(ooxmlDir, outputDir, 'not_zip');
      return;
    }
  } catch (err) {
    log('error', `Cannot read file: ${err.message}`);
    writeEmptyOutput(ooxmlDir, outputDir, 'read_error');
    return;
  }

  // ── Step 2: Parse ZIP ──
  let zip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch (err) {
    log('warn', `ZIP parse failed (corrupted/password-protected?): ${err.message}`);
    writeEmptyOutput(ooxmlDir, outputDir, 'zip_error');
    return;
  }

  // ── Step 3: Get sheet names from manifest ──
  const manifestPath = path.join(outputDir, 'manifest.json');
  let sheetNames = [];
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      sheetNames = manifest.render?.sheetNames ?? manifest.sheets?.map((s) => s.sheetName) ?? [];
    } catch {
      /* ignore */
    }
  }

  // ── Step 4: Map sheets to drawings ──
  const sheetDrawingMap = await parseSheetDrawingMap(zip);
  log('info', `Found ${sheetDrawingMap.size} sheet(s) with drawings`);

  // ── Step 5: Extract drawings per sheet ──
  const sheetsOoxml = [];
  let totalShapes = 0;
  let totalConnectors = 0;
  let totalPictures = 0;

  for (const [sheetIdx, drawingPath] of sheetDrawingMap) {
    const drawing = await extractDrawing(zip, drawingPath);
    totalShapes += drawing.shapes.length;
    totalConnectors += drawing.connectors.length;
    totalPictures += drawing.pictures.length;

    const sheetName = sheetNames[sheetIdx - 1] ?? `Sheet${sheetIdx}`;
    log(
      'info',
      `  Sheet ${sheetIdx} (${sheetName}): ${drawing.shapes.length} shapes, ${drawing.connectors.length} connectors, ${drawing.pictures.length} pictures`,
    );

    sheetsOoxml.push({
      sheetIndex: sheetIdx,
      sheetName,
      ...drawing,
    });
  }

  // ── Step 6: Extract cell values ──
  let cellSheets = [];
  try {
    cellSheets = await extractCellValues(xlsxPath);
    log(
      'info',
      `Cell extraction: ${cellSheets.reduce((s, sh) => s + sh.cells.length, 0)} cells from ${cellSheets.length} sheets`,
    );
  } catch (err) {
    log('warn', `Cell extraction failed: ${err.message}`);
  }

  // ── Step 7: Merge drawing + cell data per sheet ──
  const results = [];
  const processedSheetIndices = new Set(sheetsOoxml.map((s) => s.sheetIndex));

  for (const ooxmlSheet of sheetsOoxml) {
    const cellSheet = cellSheets.find((c) => c.sheetIndex === ooxmlSheet.sheetIndex);
    results.push({
      sheetIndex: ooxmlSheet.sheetIndex,
      sheetName: ooxmlSheet.sheetName,
      shapes: ooxmlSheet.shapes,
      connectors: ooxmlSheet.connectors,
      pictures: ooxmlSheet.pictures,
      cells: cellSheet?.cells ?? [],
      mergedRanges: cellSheet?.mergedRanges ?? [],
    });
  }

  // Add sheets that have cells but no drawings
  for (const cellSheet of cellSheets) {
    if (!processedSheetIndices.has(cellSheet.sheetIndex)) {
      results.push({
        sheetIndex: cellSheet.sheetIndex,
        sheetName: cellSheet.sheetName,
        shapes: [],
        connectors: [],
        pictures: [],
        cells: cellSheet.cells,
        mergedRanges: cellSheet.mergedRanges,
      });
    }
  }

  // Sort by sheet index
  results.sort((a, b) => a.sheetIndex - b.sheetIndex);

  // ── Step 8: Write per-sheet JSON ──
  for (const sheet of results) {
    const filename = `sheet-${String(sheet.sheetIndex).padStart(2, '0')}.json`;
    fs.writeFileSync(path.join(ooxmlDir, filename), JSON.stringify(sheet, null, 2));
  }

  // ── Step 9: List media files ──
  const mediaFiles = Object.keys(zip.files).filter((f) => f.startsWith('xl/media/'));

  // ── Step 10: Write summary ──
  const summary = {
    status: 'success',
    totalSheets: results.length,
    totalShapes,
    totalConnectors,
    totalPictures,
    totalMediaFiles: mediaFiles.length,
    totalCells: results.reduce((s, r) => s + r.cells.length, 0),
    sheets: results.map((r) => ({
      sheetIndex: r.sheetIndex,
      sheetName: r.sheetName,
      shapes: r.shapes.length,
      shapesWithText: r.shapes.filter((s) => s.hasText).length,
      connectors: r.connectors.length,
      pictures: r.pictures.length,
      cells: r.cells.length,
    })),
    mediaFiles,
  };
  fs.writeFileSync(path.join(ooxmlDir, 'summary.json'), JSON.stringify(summary, null, 2));

  // ── Step 11: Update manifest ──
  updateManifest(outputDir, summary);

  log(
    'info',
    `Done: ${totalShapes} shapes (${results.reduce((s, r) => s + r.shapes.filter((sh) => sh.hasText).length, 0)} with text), ${totalConnectors} connectors, ${totalPictures} pictures, ${summary.totalCells} cells`,
  );
}

function writeEmptyOutput(ooxmlDir, outputDir, reason) {
  const summary = {
    status: 'skipped',
    reason,
    totalSheets: 0,
    totalShapes: 0,
    totalConnectors: 0,
    totalPictures: 0,
    totalMediaFiles: 0,
    totalCells: 0,
    sheets: [],
    mediaFiles: [],
  };
  fs.writeFileSync(path.join(ooxmlDir, 'summary.json'), JSON.stringify(summary, null, 2));
  updateManifest(outputDir, summary);
}

function updateManifest(outputDir, ooxmlSummary) {
  const manifestPath = path.join(outputDir, 'manifest.json');
  let manifest = {};
  try {
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    }
  } catch {
    /* fresh manifest */
  }

  manifest.ooxml = {
    status: ooxmlSummary.status,
    totalShapes: ooxmlSummary.totalShapes,
    totalConnectors: ooxmlSummary.totalConnectors,
    totalPictures: ooxmlSummary.totalPictures,
    totalCells: ooxmlSummary.totalCells,
    totalMediaFiles: ooxmlSummary.totalMediaFiles,
    completedAt: new Date().toISOString(),
  };

  manifest.steps = manifest.steps ?? {};
  manifest.steps['extract-ooxml'] = {
    status: 'success',
    completedAt: new Date().toISOString(),
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    input: { type: 'string', short: 'i' },
    output: { type: 'string', short: 'o' },
  },
});

if (!args.input || !args.output) {
  console.error('Usage: bun scripts/extract-ooxml.mjs --input <xlsx> --output <outputDir>');
  process.exit(1);
}

const inputPath = path.resolve(args.input);
const outputDir = path.resolve(args.output);

if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });
await extractOoxml(inputPath, outputDir);

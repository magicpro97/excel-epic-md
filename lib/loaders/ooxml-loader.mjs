import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.mjs';

function loadOoxmlData(outputDir) {
  const ooxmlDir = path.join(outputDir, 'ooxml');
  const map = new Map();

  if (!fs.existsSync(ooxmlDir)) {
    log('debug', 'No OOXML data directory found — skipping');
    return map;
  }

  const files = fs.readdirSync(ooxmlDir).filter((f) => f.match(/^sheet-\d+\.json$/));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ooxmlDir, file), 'utf-8'));
      if (data.sheetIndex != null) {
        map.set(data.sheetIndex, data);
      }
    } catch {
      /* skip corrupt files */
    }
  }

  if (map.size > 0) {
    const totalShapes = [...map.values()].reduce((s, d) => s + (d.shapes?.length || 0), 0);
    const totalCells = [...map.values()].reduce((s, d) => s + (d.cells?.length || 0), 0);
    log('info', `📦 OOXML data loaded: ${map.size} sheets, ${totalShapes} shapes, ${totalCells} cells`);
  }

  return map;
}

/**
 * Format OOXML data as text section for prompt injection.
 * Enriches callout shapes with target cell values for better context.
 * @param {object} ooxmlSheet - OOXML data for a single sheet
 * @returns {string} Formatted text to prepend to prompt
 */
function formatOoxmlForPrompt(ooxmlSheet) {
  if (!ooxmlSheet) return '';

  const parts = [];
  const shapes = ooxmlSheet.shapes || [];
  const connectors = ooxmlSheet.connectors || [];
  const pictures = ooxmlSheet.pictures || [];
  const cells = ooxmlSheet.cells || [];

  // Build cell lookup: "row,col" → cell value (for callout→cell mapping)
  const cellLookup = new Map();
  for (const c of cells) {
    if (c.row != null && c.col != null) {
      cellLookup.set(`${c.row},${c.col}`, c);
    }
  }

  const shapesWithText = shapes.filter((s) => s.hasText);
  if (shapesWithText.length > 0 || connectors.length > 0) {
    parts.push(`## OOXML Shapes (XML-extracted — 100% accurate, ưu tiên cao hơn OCR)`);
    parts.push(`${shapesWithText.length} shapes, ${connectors.length} connectors, ${pictures.length} pictures\n`);

    for (const s of shapesWithText) {
      const pos = s.position ? ` (row ${s.position.fromRow}-${s.position.toRow}, col ${s.position.fromCol}-${s.position.toCol})` : '';

      // Resolve callout target cells — find cells within the shape's position range
      let targetContext = '';
      if (s.position && cells.length > 0) {
        const targetCells = findCellsInRange(
          cells, s.position.fromRow, s.position.toRow, s.position.fromCol, s.position.toCol,
        );
        if (targetCells.length > 0) {
          const cellTexts = targetCells.slice(0, 5).map((c) => `${c.address}="${c.value}"`);
          targetContext = `\n  → targets: ${cellTexts.join(', ')}`;
          if (targetCells.length > 5) targetContext += ` (+${targetCells.length - 5} more)`;
        }
      }

      parts.push(`- [${s.id}] [${s.type}] ${s.text}${pos}${targetContext}`);
    }

    if (connectors.length > 0) {
      parts.push('');
      for (const c of connectors) {
        parts.push(`- [connector] ${c.type}: row ${c.from?.row},col ${c.from?.col} → row ${c.to?.row},col ${c.to?.col}`);
      }
    }

    if (pictures.length > 0) {
      parts.push('');
      parts.push(`📷 ${pictures.length} picture(s) embedded — content not readable via text, see rendered image.`);
    }
  }

  if (cells.length > 0) {
    parts.push('');
    parts.push(`## Cell Values (ExcelJS-extracted — 100% accurate)`);
    const displayCells = cells.slice(0, 200);
    for (const c of displayCells) {
      const mergeTag = c.merged ? ' [merged]' : '';
      parts.push(`- ${c.address}: "${c.value}"${mergeTag}`);
    }
    if (cells.length > 200) {
      parts.push(`... and ${cells.length - 200} more cells`);
    }
  }

  return parts.length > 0 ? parts.join('\n') + '\n' : '';
}

/**
 * Find cells whose row/col fall within a given range
 * @param {Array<{row: number, col: number, address: string, value: string}>} cells
 * @param {number} fromRow - Start row (inclusive)
 * @param {number} toRow - End row (inclusive)
 * @param {number} fromCol - Start col (inclusive)
 * @param {number} toCol - End col (inclusive)
 * @returns {Array} Matching cells
 */
function findCellsInRange(cells, fromRow, toRow, fromCol, toCol) {
  return cells.filter((c) =>
    c.row >= fromRow && c.row <= toRow &&
    c.col >= fromCol && c.col <= toCol &&
    c.value && c.value.trim().length > 0,
  );
}

export { loadOoxmlData, formatOoxmlForPrompt };

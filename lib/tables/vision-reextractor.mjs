import fs from 'fs';
import path from 'path';
import { GeminiClient } from '../llm-clients/gemini-client.mjs';
import { SYSTEM_INSTRUCTION } from '../prompts/system-instruction.mjs';
import { log } from '../utils/logger.mjs';

/**
 * Prompt for vision-based table re-extraction.
 * Sends the page image to Gemini Vision to get a clean markdown table.
 * @param {string} tableTitle - Current table title for context
 * @param {string} brokenTable - The misaligned markdown table for reference
 * @returns {string} Prompt for vision model
 */
const visionTablePrompt = (tableTitle, brokenTable) => `
This page image contains a specification table. The OCR-extracted table below has MISALIGNED columns
(different rows have different numbers of columns). Please re-extract the table from the image
with correct column alignment.

## Current (broken) table title: "${tableTitle}"

## Current (broken) table for reference:
${brokenTable.substring(0, 2000)}

## Instructions:
1. Look at the image and identify the table structure (headers, columns, rows)
2. Re-create the table in clean Markdown format with consistent columns
3. Preserve the original Japanese text and bilingual annotations
4. Ensure every row has the same number of | separators
5. Keep Evidence IDs if visible

## Output format (JSON):
{
  "markdownTable": "| col1 | col2 | ... |\\n|---|---|---|\\n| data | data | ... |",
  "columnCount": 8,
  "rowCount": 15,
  "notes": "Brief note about what was fixed"
}
`;

/**
 * Resolve the page image path for a table by extracting page number from
 * evidence ID in title or the pageNumber field.
 * @param {{ title?: string, pageNumber?: number }} table - Table with title/pageNumber
 * @param {string} renderPagesDir - Directory containing rendered page PNGs
 * @returns {{ pageNum: number, imagePath: string } | null} Resolved path or null
 */
function resolveTablePageImage(table, renderPagesDir) {
  const evMatch = (table.title || '').match(/EV-p(\d+)/);
  const pageNum = evMatch ? parseInt(evMatch[1], 10) : table.pageNumber;
  if (!pageNum) {
    log('warn', `  ⚠️ Cannot determine page for "${table.title}" — skipping vision`);
    return null;
  }

  const imagePath = path.join(renderPagesDir, `page-${String(pageNum).padStart(4, '0')}.png`);
  if (!fs.existsSync(imagePath)) {
    log('warn', `  ⚠️ Image not found: ${imagePath} — skipping vision`);
    return null;
  }
  return { pageNum, imagePath };
}

/**
 * Apply a vision re-extraction result to a misaligned table.
 * Validates column consistency before accepting the replacement.
 * @param {{ title: string, markdownTable: string, notes?: string, _misaligned?: boolean }} table - Table to update (mutated)
 * @param {{ markdownTable: string, columnCount?: number, notes?: string }} result - Vision result
 * @param {number} pageNum - Page number for logging
 * @returns {boolean} Whether the vision result was accepted
 */
function applyVisionResult(table, result, pageNum) {
  const newLines = result.markdownTable.split('\\n').filter((l) => l.trim().startsWith('|'));
  const newPipes = new Set(newLines.map((l) => l.split('|').length));

  if (newPipes.size > 1 && newLines.length <= 3) {
    log('warn', `  ⚠️ Vision result still misaligned for "${table.title}" — keeping original`);
    return false;
  }

  const oldRowCount = table.markdownTable.split('\\n').filter((l) => l.trim().startsWith('|')).length;
  table.markdownTable = result.markdownTable;
  table.notes = (table.notes || '').replace(/⚠️ MISALIGNED:.*$/, '').trim() || undefined;
  delete table._misaligned;
  log(
    'info',
    `  ✅ Vision fixed "${table.title}" (p${pageNum}): ${oldRowCount} → ${newLines.length} rows, ${result.columnCount || '?'} cols`,
  );
  return true;
}

/**
 * Re-extract misaligned tables using Gemini Vision.
 * For tables flagged with _misaligned=true, sends the page image to Vision
 * to get a correctly structured markdown table.
 * @param {Array<{title: string, markdownTable: string, _misaligned?: boolean, pageNumber?: number}>} tables - Tables to process
 * @param {string} outputDir - Root output directory
 * @returns {Promise<void>}
 */
async function reExtractMisalignedTables(tables, outputDir) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return;

  const misaligned = tables.filter((t) => t._misaligned);
  if (misaligned.length === 0) return;

  const renderPagesDir = path.join(outputDir, 'render', 'pages');
  if (!fs.existsSync(renderPagesDir)) {
    log('warn', '⚠️ No render pages directory — skipping vision re-extraction');
    return;
  }

  const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const visionClient = new GeminiClient(geminiKey, geminiModel);

  log('info', `🖼️  Vision table re-extraction: ${misaligned.length} misaligned table(s)`);

  let fixed = 0;
  for (const table of misaligned) {
    const resolved = resolveTablePageImage(table, renderPagesDir);
    if (!resolved) continue;

    try {
      const prompt = visionTablePrompt(table.title, table.markdownTable);
      const result = await visionClient.generateVision(resolved.imagePath, prompt, SYSTEM_INSTRUCTION);

      if (result?.markdownTable && applyVisionResult(table, result, resolved.pageNum)) {
        fixed++;
      }
    } catch (err) {
      log('warn', `  ⚠️ Vision re-extraction failed for "${table.title}": ${err.message.slice(0, 100)}`);
    }
  }

  if (fixed > 0) {
    log('info', `🖼️  Vision fixed ${fixed}/${misaligned.length} misaligned table(s)`);
  }
}

export { applyVisionResult, reExtractMisalignedTables, resolveTablePageImage, visionTablePrompt };

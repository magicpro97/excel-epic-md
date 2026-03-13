import { log } from '../utils/logger.mjs';

/**
 * Known entity prefixes found in TSV spec column names.
 * Maps column prefix patterns → entity display name.
 * @type {Array<{pattern: RegExp, entity: string}>}
 */
const ENTITY_PREFIX_PATTERNS = [
  { pattern: /\buser\b/i, entity: 'User' },
  { pattern: /\brole\b/i, entity: 'Role' },
  { pattern: /\bhospital\b/i, entity: 'Hospital' },
  { pattern: /\bstaff\b/i, entity: 'Staff' },
  { pattern: /\bbrigade\b/i, entity: 'Brigade' },
  { pattern: /\bvehicle\b/i, entity: 'Vehicle' },
  { pattern: /\bActivityS/i, entity: 'ActivitySequence' },
  { pattern: /\bIncidentT/i, entity: 'IncidentType' },
  { pattern: /\bSystemC/i, entity: 'SystemCode' },
  { pattern: /\bDepartment\b/i, entity: 'Department' },
];

/**
 * Detect entity name from a markdown table's content by analyzing column prefixes.
 * Looks at the first column of data rows for patterns like "1user", "2Hospital", "ActivityS".
 * @param {string} markdownTable - Markdown table string
 * @returns {string|null} Detected entity name or null
 */
function detectEntityFromTable(markdownTable) {
  if (!markdownTable) return null;

  // Extract first column values from data rows (skip header + separator)
  const lines = markdownTable.split('\n').filter((l) => l.trim().startsWith('|'));
  const dataRows = lines.slice(2); // skip header + separator

  for (const row of dataRows) {
    const cells = row
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length === 0) continue;

    const firstCell = cells[0];
    for (const { pattern, entity } of ENTITY_PREFIX_PATTERNS) {
      if (pattern.test(firstCell)) {
        return entity;
      }
    }
  }

  return null;
}

/** Generic table name patterns that need entity disambiguation */
const GENERIC_TABLE_PATTERNS = [
  /TSVファイルの仕様/,
  /インポートTSVファイルの仕様/,
  /TSVのインポート仕様/,
  /TSVインポート仕様/,
  /TSVの仕様/,
  /インポート処理/,
  /ファイルの仕様/,
  /^Danh sách/,
  /^Specification Table$/,
  /^Thông tin/,
  /^Quy định/,
];

/**
 * Check whether a table title is generic/vague and needs entity enrichment.
 * @param {string} title - Table title
 * @returns {boolean} True if the title is generic
 */
function isGenericTableTitle(title) {
  return GENERIC_TABLE_PATTERNS.some((p) => p.test(title)) || title === 'N/A' || title.length < 3;
}

/**
 * Check whether a title already contains a known entity name.
 * @param {string} title - Table title
 * @returns {boolean} True if entity is already present
 */
function titleHasEntity(title) {
  const lower = title.toLowerCase();
  return ENTITY_PREFIX_PATTERNS.some(({ entity }) => lower.includes(entity.toLowerCase()));
}

/**
 * Resolve entity name from manifest's page-to-sheet mapping.
 * Extracts page number from EV-pNNNN in the title and looks up sheet name.
 * @param {string} title - Table title
 * @param {number|undefined} pageNumber - Optional page number from table
 * @param {Map<number, string>} pageToSheet - Page-to-sheet name map
 * @returns {string|null} Resolved entity or null
 */
function resolveEntityFromSheet(title, pageNumber, pageToSheet) {
  const evMatch = title.match(/EV-p(\d+)/);
  const pageNum = evMatch ? parseInt(evMatch[1], 10) : pageNumber;
  if (!pageNum) return null;

  const sheetName = pageToSheet.get(pageNum);
  if (!sheetName) return null;

  // Extract entity hint from sheetName like "項目-User" → "User"
  const sheetEntity = sheetName.replace(/^項目-/, '').replace(/^参考-/, '');
  return sheetEntity !== sheetName.replace(/^[^-]+-/, '') ? sheetEntity : sheetName;
}

/**
 * Enrich table titles by adding entity context when titles are duplicated.
 * Also adds entity context from detectEntityFromTable for any table whose title
 * suggests it's a generic spec table.
 * @param {Array<{title: string, markdownTable: string, notes?: string, pageNumber?: number}>} tables - Tables to enrich (mutated)
 * @param {Map<number, string>} pageToSheet - Page-to-sheet name map from manifest
 */
function enrichTableTitles(tables, pageToSheet = new Map()) {
  let enriched = 0;
  for (const table of tables) {
    const title = table.title || '';

    if (!isGenericTableTitle(title) || titleHasEntity(title)) continue;

    // Strategy 1: detect entity from table content (column prefixes)
    // Strategy 2: fallback to sheetName from manifest page mapping
    const entity =
      detectEntityFromTable(table.markdownTable) ||
      (pageToSheet.size > 0 ? resolveEntityFromSheet(title, table.pageNumber, pageToSheet) : null);

    if (entity) {
      const oldTitle = table.title;
      table.title = title === 'N/A' || title.length < 3 ? `Specification Table - ${entity}` : `${title} - ${entity}`;
      log('info', `  📋 Enriched table title: "${oldTitle}" → "${table.title}"`);
      enriched++;
    }
  }

  if (enriched > 0) {
    log('info', `📋 Enriched ${enriched} table title(s) with entity context`);
  }
}

export { detectEntityFromTable, enrichTableTitles, isGenericTableTitle, resolveEntityFromSheet, titleHasEntity };

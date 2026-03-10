import { log } from '../utils/logger.mjs';

/**
 * Flag tables with very few data rows as potentially broken/incomplete.
 * Adds a warning note to tables with < 3 data rows.
 * @param {Array<{title: string, markdownTable: string, notes?: string}>} tables - Tables to check (mutated)
 */
/**
 * Titles matching these patterns are expected to have few rows (detail/impact tables)
 * @type {RegExp}
 */
const SMALL_TABLE_PATTERNS = /影響詳細|Chi tiết ảnh hưởng|Detail|処理方針|Menu構成/i;

function flagBrokenTables(tables) {
  const MIN_DATA_ROWS = 3;
  let flagged = 0;

  for (const table of tables) {
    if (!table.markdownTable) continue;

    const lines = table.markdownTable.split('\n').filter((l) => l.trim().startsWith('|'));
    const dataRowCount = Math.max(0, lines.length - 2); // subtract header + separator

    // Skip small-row check for tables that are expected to be small
    if (dataRowCount < MIN_DATA_ROWS && dataRowCount > 0 && !SMALL_TABLE_PATTERNS.test(table.title || '')) {
      const warning = `⚠️ Bảng có thể không đầy đủ (chỉ ${dataRowCount} dòng dữ liệu). Kiểm tra lại nguồn gốc.`;
      table.notes = table.notes ? `${table.notes}\n${warning}` : warning;
      log('warn', `  ⚠️ Broken table detected: "${table.title}" (${dataRowCount} data rows)`);
      flagged++;
    }

    // Detect column misalignment (different pipe counts across rows)
    const pipeCounts = lines.map((l) => l.split('|').length);
    const uniquePipes = new Set(pipeCounts);
    if (uniquePipes.size > 1 && dataRowCount > 2) {
      const warning = `⚠️ MISALIGNED: Bảng có ${uniquePipes.size} cấu trúc cột khác nhau (${[...uniquePipes].join(',')} pipes). OCR có thể đã parse sai cấu trúc bảng phức tạp.`;
      table.notes = table.notes ? `${table.notes}\n${warning}` : warning;
      table._misaligned = true;
      log(
        'warn',
        `  ⚠️ Misaligned table: "${table.title}" (${uniquePipes.size} pipe variations: ${[...uniquePipes].join(',')})`,
      );
      flagged++;
    }
  }

  if (flagged > 0) {
    log('warn', `⚠️ ${flagged} potentially broken table(s) flagged`);
  }
}

export { flagBrokenTables };

import { log } from '../utils/logger.mjs';

/**
 * Common OCR truncation/misread patterns in Japanese text.
 * PaddleOCR frequently truncates long-vowel marks (ー) and confuses
 * similar characters (卜/ト, ン/ソ). These are deterministic corrections
 * applied AFTER LLM synthesis to avoid relying on LLM to fix OCR artifacts.
 * @type {Array<{pattern: RegExp, replacement: string, description: string}>}
 */
const OCR_CORRECTION_DICTIONARY = [
  // Long-vowel truncation (most common)
  { pattern: /エクス一卜/g, replacement: 'エクスポート', description: 'export' },
  { pattern: /エクスポ一卜/g, replacement: 'エクスポート', description: 'export' },
  { pattern: /エクス一ト/g, replacement: 'エクスポート', description: 'export' },
  { pattern: /イン一卜/g, replacement: 'インポート', description: 'import' },
  { pattern: /インポ一卜/g, replacement: 'インポート', description: 'import' },
  { pattern: /イン一ト/g, replacement: 'インポート', description: 'import' },
  { pattern: /テナ卜/g, replacement: 'テナント', description: 'tenant' },
  { pattern: /テナン卜/g, replacement: 'テナント', description: 'tenant' },
  { pattern: /ユザー/g, replacement: 'ユーザー', description: 'user' },
  { pattern: /セグメン卜/g, replacement: 'セグメント', description: 'segment' },
  { pattern: /セグメソト/g, replacement: 'セグメント', description: 'segment' },
  { pattern: /アカウン卜/g, replacement: 'アカウント', description: 'account' },
  { pattern: /デフォル卜/g, replacement: 'デフォルト', description: 'default' },
  { pattern: /チェッ夕/g, replacement: 'チェック', description: 'check (data)' },
  // ト vs 卜 confusion (katakana vs radical)
  { pattern: /リクエス卜/g, replacement: 'リクエスト', description: 'request' },
  { pattern: /コメン卜/g, replacement: 'コメント', description: 'comment' },
  { pattern: /マスタ一/g, replacement: 'マスター', description: 'master' },
  { pattern: /デー夕/g, replacement: 'データ', description: 'data' },
  { pattern: /ソー卜/g, replacement: 'ソート', description: 'sort' },
  { pattern: /ポイン卜/g, replacement: 'ポイント', description: 'point' },
  // segmentId / tenantId common OCR errors
  { pattern: /segmentld/g, replacement: 'segmentId', description: 'segmentId (l→I)' },
  { pattern: /tenantld/g, replacement: 'tenantId', description: 'tenantId (l→I)' },
  { pattern: /brigadeld/g, replacement: 'brigadeId', description: 'brigadeId (l→I)' },
  { pattern: /hospitalld/g, replacement: 'hospitalId', description: 'hospitalId (l→I)' },
  { pattern: /staffld/g, replacement: 'staffId', description: 'staffId (l→I)' },
  // Other common OCR misreads
  { pattern: /ログイ一ザ/g, replacement: 'ログインユーザ', description: 'login user' },
  { pattern: /ログイ-ザ/g, replacement: 'ログインユーザ', description: 'login user' },
  { pattern: /ログインーザー/g, replacement: 'ログインユーザー', description: 'login user' },
];

/**
 * Apply deterministic OCR text corrections to all table content.
 * Corrects common PaddleOCR truncation/misread patterns in Japanese text.
 * Mutates tables in place.
 * @param {Array<{title: string, markdownTable: string, notes?: string}>} tables - Tables to correct
 * @returns {void}
 */
function correctOcrTruncation(tables) {
  let totalCorrections = 0;
  const correctionCounts = new Map();

  for (const table of tables) {
    for (const field of ['title', 'markdownTable', 'notes']) {
      if (!table[field]) continue;
      let text = table[field];
      for (const { pattern, replacement, description } of OCR_CORRECTION_DICTIONARY) {
        const matches = text.match(pattern);
        if (matches) {
          text = text.replace(pattern, replacement);
          const count = matches.length;
          totalCorrections += count;
          correctionCounts.set(description, (correctionCounts.get(description) || 0) + count);
        }
      }
      table[field] = text;
    }
  }

  if (totalCorrections > 0) {
    const details = [...correctionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([desc, count]) => `${desc}(${count})`)
      .join(', ');
    log('info', `🔤 OCR corrections: ${totalCorrections} fixes applied [${details}]`);
  }
}

export { correctOcrTruncation, OCR_CORRECTION_DICTIONARY };

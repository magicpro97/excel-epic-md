import fs from 'fs';
import path from 'path';
import { GeminiClient } from '../llm-clients/gemini-client.mjs';
import { visionPagePrompt } from '../prompts/page-prompts.mjs';
import { SYSTEM_INSTRUCTION } from '../prompts/system-instruction.mjs';
import { RUN_STATS } from '../stats/run-stats.mjs';
import { savePageCache } from '../utils/cache.mjs';
import { log } from '../utils/logger.mjs';

/**
 * Retry empty pages using Gemini Vision (image-based analysis)
 * @param {Array<object>} pageSummaries - Page summaries (mutated in place)
 * @param {string} summariesDir - Path to summaries directory
 * @param {string} outputDir - Base output directory
 * @returns {Promise<void>}
 */
async function retryEmptyPagesWithVision(pageSummaries, summariesDir, outputDir) {
  const emptyPages = pageSummaries.filter((p) => p.pageType === 'empty');
  if (emptyPages.length === 0) return;

  const geminiKey = process.env.GEMINI_API_KEY;
  const renderPagesDir = path.join(outputDir, 'render', 'pages');
  if (!geminiKey || !fs.existsSync(renderPagesDir)) return;

  const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const visionClient = new GeminiClient(geminiKey, geminiModel);
  log('info', `🖼️  Vision retry: ${emptyPages.length} empty page(s) → Gemini Vision`);

  for (const emptyPage of emptyPages) {
    const { pageNumber } = emptyPage;
    const imagePath = path.join(renderPagesDir, `page-${String(pageNumber).padStart(4, '0')}.png`);
    if (!fs.existsSync(imagePath)) continue;
    try {
      const prompt = visionPagePrompt(pageNumber);
      const result = await visionClient.generateVision(imagePath, prompt, SYSTEM_INSTRUCTION);
      const idx = pageSummaries.findIndex((p) => p.pageNumber === pageNumber);
      if (idx !== -1) pageSummaries[idx] = result;
      savePageCache(summariesDir, pageNumber, result);
      RUN_STATS.pageStats.visionRetried++;
      log('info', `✅ Page ${pageNumber} analyzed via Vision`);
    } catch (err) {
      log('warn', `⚠️  Vision failed for page ${pageNumber}: ${err.message.slice(0, 80)}`);
    }
  }
}

export { retryEmptyPagesWithVision };

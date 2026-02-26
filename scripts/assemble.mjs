#!/usr/bin/env bun
/**
 * Assemble final output.md from epic synthesis
 *
 * Output format:
 * - Vietnamese markdown, clean and readable
 * - Evidence IDs removed from final output (kept in JSON for traceability)
 * - Requirements sorted by priority, tasks by logical order
 * - Appendix with evidence reference
 */

import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

/**
 * Parse command line arguments using yargs
 * @returns {{ input: string | null, output: string | null }} Parsed arguments
 */
function parseArgs() {
  const argv = yargs(hideBin(process.argv))
    .usage('Usage: $0 --input <inputDir> --output <outputFile>')
    .option('input', {
      alias: 'i',
      type: 'string',
      description: 'Input directory containing synthesized data',
    })
    .option('output', {
      alias: 'o',
      type: 'string',
      description: 'Output markdown file path',
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
 * Format requirements section as markdown
 * @param {Array<{id: string, priority?: string, description: string, evidenceIds?: string[]}>} requirements - Requirements array
 * @returns {string} Formatted markdown string
 */
function formatRequirements(requirements) {
  if (!requirements || requirements.length === 0) {
    return '- N/A - Chưa có yêu cầu được xác định\n';
  }

  // Sort requirements by ID for better readability
  const sorted = [...requirements].sort((a, b) => (a.id || '').localeCompare(b.id || ''));

  return sorted
    .map((req) => {
      const priority = req.priority ? ` [${req.priority.toUpperCase()}]` : '';
      // Evidence IDs kept in JSON for traceability, but removed from final output for readability
      return `- **${req.id || 'REQ-???'}**${priority}: ${req.description || 'N/A'}`;
    })
    .join('\n');
}

/**
 * Format tasks section as markdown
 * @param {Array<{id: string, description: string, relatedRequirements?: string[], evidenceIds?: string[]}>} tasks - Tasks array
 * @returns {string} Formatted markdown string
 */
function formatTasks(tasks) {
  if (!tasks || tasks.length === 0) {
    return '- N/A - Chưa có công việc được xác định\n';
  }

  // Sort tasks by ID for better readability
  const sorted = [...tasks].sort((a, b) => (a.id || '').localeCompare(b.id || ''));

  return sorted
    .map((task) => {
      const related =
        task.relatedRequirements?.length > 0 ? ` (Liên quan: ${task.relatedRequirements.join(', ')})` : '';
      // Evidence IDs kept in JSON for traceability, but removed from final output for readability
      return `- **${task.id || 'TASK-???'}**: ${task.description || 'N/A'}${related}`;
    })
    .join('\n');
}

/**
 * Format list items as markdown with fallback
 * @param {string[] | string | undefined} items - List items (array or string)
 * @param {string} fallback - Fallback text if empty
 * @returns {string} Formatted markdown string
 */
function formatListWithEvidence(items, fallback = 'N/A') {
  // Handle null/undefined
  if (!items) {
    return `- ${fallback}\n`;
  }

  // Handle string (not array) - LLM sometimes returns string instead of array
  if (typeof items === 'string') {
    return `- ${items}\n`;
  }

  // Handle non-array or empty array
  if (!Array.isArray(items) || items.length === 0) {
    return `- ${fallback}\n`;
  }

  return items.map((item) => `- ${item}`).join('\n');
}

/**
 * Format open questions as markdown
 * @param {Array<string | {question: string, context?: string, relatedEvidence?: string[]}>} questions - Questions array
 * @returns {string} Formatted markdown string
 */
function formatOpenQuestions(questions) {
  if (!questions || questions.length === 0) {
    return '- Không có câu hỏi mở\n';
  }

  // Filter out garbage/noise entries
  const cleanQuestions = questions.filter((q) => {
    if (!q) return false;
    const text = typeof q === 'string' ? q : q.question;
    if (!text || text.length < 5) return false;
    // Filter out common OCR garbage patterns
    if (/^[^a-zA-Z\u3040-\u30FF\u4E00-\u9FFF\u00C0-\u024F]{4,}$/.test(text)) return false;
    // Filter out error messages
    return !/chunk.*failed|error:|missing|timeout/i.test(text);
  });

  return cleanQuestions.length === 0
    ? '- Không có câu hỏi mở\n'
    : cleanQuestions
        .map((q) => {
          if (typeof q === 'string') {
            return `- ${q}`;
          }
          const evidence = q.relatedEvidence?.length > 0 ? ` [${q.relatedEvidence.join(', ')}]` : '';
          const context = q.context && q.context !== 'N/A' ? `\n  - Context: ${q.context}` : '';
          return `- **${q.question}**${evidence}${context}`;
        })
        .join('\n');
}

/**
 * Format tables as markdown
 * @param {Array<{title: string, markdownTable: string, notes?: string}>} tables - Tables array
 * @returns {string} Formatted markdown string
 */
function formatTables(tables) {
  if (!tables || tables.length === 0) {
    return 'Không có bảng specification trong tài liệu này.\n';
  }

  return tables
    .map((table, index) => {
      const title = table.title || `Bảng ${index + 1}`;
      const mdTable = table.markdownTable || '*Không có dữ liệu bảng*';
      const notes = table.notes ? `\n\n> **Ghi chú:** ${table.notes}` : '';
      return `### ${title}\n\n${mdTable}${notes}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Generate evidence appendix from OCR data
 * @param {string} outputDir - Output directory containing OCR files
 * @returns {string} Formatted markdown appendix
 */
function generateAppendix(outputDir) {
  const ocrDir = path.join(outputDir, 'ocr');

  if (!fs.existsSync(ocrDir)) {
    return '## Phụ lục: Nguồn Evidence\n\nKhông có dữ liệu OCR.\n';
  }

  const ocrFiles = fs
    .readdirSync(ocrDir)
    .filter((f) => f.match(/^page-\d+\.json$/))
    .sort();

  let appendix = '## Phụ lục: Nguồn Evidence\n\n';
  appendix += 'Danh sách Evidence ID và nội dung gốc từ OCR.\n\n';

  // Limit to first 50 pages to avoid extremely long appendix
  const maxPages = 50;
  const limitedFiles = ocrFiles.slice(0, maxPages);
  if (ocrFiles.length > maxPages) {
    appendix += `> **Lưu ý:** Chỉ hiển thị ${maxPages}/${ocrFiles.length} trang đầu tiên.\n\n`;
  }

  for (const ocrFile of limitedFiles) {
    const ocrPath = path.join(ocrDir, ocrFile);
    const ocrData = JSON.parse(fs.readFileSync(ocrPath, 'utf-8'));

    if (!ocrData.blocks || ocrData.blocks.length === 0) continue;

    // Filter out blocks with undefined/invalid evidenceId
    const validBlocks = ocrData.blocks.filter(
      (block) => block.evidenceId && block.evidenceId !== 'undefined' && block.text && block.text.trim().length > 0,
    );

    if (validBlocks.length === 0) continue;

    appendix += `### Trang ${ocrData.page}\n\n`;
    appendix += `**File ảnh:** \`render/pages/${ocrData.filename}\`\n\n`;

    appendix += '| Evidence ID | Nội dung | Confidence |\n';
    appendix += '|-------------|----------|------------|\n';

    for (const block of validBlocks) {
      const text = block.text.replace(/\|/g, '\\|').replace(/\n/g, ' ').substring(0, 100);
      const truncated = block.text.length > 100 ? '...' : '';
      const confidence = block.isAmbiguous ? `⚠️ ${block.confidence}` : `✅ ${block.confidence}`;
      appendix += `| \`${block.evidenceId}\` | ${text}${truncated} | ${confidence} |\n`;
    }

    appendix += '\n';
  }

  return appendix;
}

/**
 * Generate final markdown document from synthesis
 * @param {object} synthesis - Epic synthesis result
 * @param {{ docId?: string, sourceName?: string }} manifest - Manifest data
 * @param {string} outputDir - Output directory
 * @returns {string} Complete markdown document
 */
function generateMarkdown(synthesis, manifest, outputDir) {
  const epic = synthesis.epic || {};
  const context = synthesis.context || {};

  const docId = manifest.docId || 'Unknown';
  const sourceName = manifest.sourceName || 'Unknown';
  const createdAt = new Date().toISOString().split('T')[0];

  let md = `# ${epic.title || 'Epic Requirement'}

> **Document ID:** ${docId}
> **Source:** ${sourceName}
> **Generated:** ${createdAt}
> **Tool:** excel-epic-md

---

## Tóm tắt

${epic.summary || 'N/A - Chưa có tóm tắt'}

---

## 1. Bối cảnh

### 1.1 Background

${context.background || 'N/A - Cần bổ sung thông tin bối cảnh'}

### 1.2 Mục tiêu

${formatListWithEvidence(context.objectives, 'Chưa xác định mục tiêu')}

### 1.3 Phạm vi

${context.scope || 'N/A - Cần xác định phạm vi'}

---

## 2. Yêu cầu chi tiết

### 2.1 Functional Requirements

${formatRequirements(synthesis.requirements?.filter((r) => r.category === 'functional' || !r.category))}

### 2.2 Non-Functional Requirements

${formatRequirements(synthesis.requirements?.filter((r) => r.category === 'non-functional'))}

### 2.3 Constraints

${formatRequirements(synthesis.requirements?.filter((r) => r.category === 'constraint'))}

---

## 3. Công việc cụ thể

${formatTasks(synthesis.tasks)}

---

## 4. Tiêu chí nghiệm thu (Acceptance Criteria)

${formatListWithEvidence(synthesis.acceptanceCriteria, 'Chưa xác định tiêu chí nghiệm thu')}

---

## 5. Giả định (Assumptions)

${formatListWithEvidence(synthesis.assumptions, 'Không có giả định đặc biệt')}

---

## 6. Câu hỏi mở (Open Questions)

${formatOpenQuestions(synthesis.openQuestions)}

---

## 7. Bảng Specification

${formatTables(synthesis.tables)}

---

## 8. Tham khảo

${formatListWithEvidence(synthesis.appendix?.references, 'Không có tài liệu tham khảo')}

### Figures/Diagrams

${formatListWithEvidence(synthesis.appendix?.figures, 'Không có hình minh họa')}

---

${generateAppendix(outputDir)}

---

*Tài liệu này được tạo tự động từ file Excel bằng tool excel-epic-md.*
*Mọi thông tin đều có trích dẫn Evidence ID để truy vết nguồn gốc.*
`;

  return md;
}

/**
 * Main entry point
 * @returns {Promise<void>} Promise that resolves when assembly completes
 */
async function main() {
  const args = parseArgs();

  if (!args.output) {
    console.error('Usage: node assemble.mjs --output <outputDir>');
    process.exit(1);
  }

  const outputDir = path.resolve(args.output);
  const llmDir = path.join(outputDir, 'llm');
  const synthesisPath = path.join(llmDir, 'epic_synthesis.json');
  const manifestPath = path.join(outputDir, 'manifest.json');

  // Validate
  if (!fs.existsSync(synthesisPath)) {
    console.error(`❌ Synthesis file not found: ${synthesisPath}`);
    process.exit(1);
  }

  // Load data
  const synthesis = JSON.parse(fs.readFileSync(synthesisPath, 'utf-8'));
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) : {};

  console.log('  📝 Generating output.md...');

  // Generate markdown
  const markdown = generateMarkdown(synthesis, manifest, outputDir);

  // Write output
  const outputPath = path.join(outputDir, 'output.md');
  fs.writeFileSync(outputPath, markdown, 'utf-8');

  console.log(`  ✅ Output written to: ${outputPath}`);

  // Update manifest
  if (fs.existsSync(manifestPath)) {
    manifest.output = {
      path: 'output.md',
      generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  // Print stats
  const stats = {
    requirements: synthesis.requirements?.length || 0,
    tasks: synthesis.tasks?.length || 0,
    openQuestions: synthesis.openQuestions?.length || 0,
  };

  console.log('\n  📊 Output Statistics:');
  console.log(`     Requirements: ${stats.requirements}`);
  console.log(`     Tasks: ${stats.tasks}`);
  console.log(`     Open Questions: ${stats.openQuestions}`);
}

main().catch((err) => {
  console.error(`❌ Assemble failed: ${err.message}`);
  process.exit(1);
});

/**
 * @module report-saver
 * Saves issues creation report to JSON and prints summary.
 */

import fs from 'fs';
import path from 'path';

/**
 * Save issues report to JSON file alongside the synthesis output
 * @param {string} synthesisPath - Path to the source epic_synthesis.json
 * @param {{ epicResult: object, taskResults: Array<object> }} results - Creation results
 * @param {string} repo - Target repository
 * @param {object} options - Additional options
 * @param {string} options.strategy - Strategy used
 * @param {boolean} options.assignCopilot - Whether Copilot was assigned
 */
export function saveReport(synthesisPath, results, repo, options = {}) {
  const { epicResult, taskResults } = results;
  const outputDir = path.dirname(synthesisPath);

  const report = {
    generatedAt: new Date().toISOString(),
    sourceFile: path.basename(synthesisPath),
    targetRepo: repo,
    strategy: options.strategy || 'task',
    epicIssue: {
      number: epicResult.number,
      url: epicResult.url,
    },
    taskIssues: taskResults.map((tr) => ({
      taskId: tr.taskId,
      number: tr.number,
      url: tr.url,
      labels: tr.labels,
      assignedToCopilot: tr.assignedToCopilot,
    })),
    summary: {
      totalIssues: 1 + taskResults.length,
      epicIssue: 1,
      taskIssues: taskResults.length,
      assignedToCopilot: taskResults.filter((t) => t.assignedToCopilot).length,
      byPriority: countByLabel(taskResults, 'priority:'),
    },
  };

  const reportPath = path.join(outputDir, 'issues-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 Report saved: ${reportPath}`);

  // Print summary
  printSummary(report);

  return report;
}

/**
 * Count issues by label prefix
 * @param {Array<object>} taskResults - Task results with labels
 * @param {string} prefix - Label prefix (e.g. 'priority:')
 * @returns {Record<string, number>}
 */
function countByLabel(taskResults, prefix) {
  const counts = {};
  for (const tr of taskResults) {
    for (const label of tr.labels || []) {
      if (label.startsWith(prefix)) {
        const value = label.substring(prefix.length);
        counts[value] = (counts[value] || 0) + 1;
      }
    }
  }
  return counts;
}

/**
 * Print a human-readable summary to console
 * @param {object} report - Issues report
 */
function printSummary(report) {
  console.log('\n' + '═'.repeat(50));
  console.log('📊 Issues Report Summary');
  console.log('═'.repeat(50));
  console.log(`  Repository:       ${report.targetRepo}`);
  console.log(`  Epic Issue:       #${report.epicIssue.number}`);
  console.log(`  Task Issues:      ${report.summary.taskIssues}`);
  console.log(`  Total Issues:     ${report.summary.totalIssues}`);
  console.log(`  Assigned Copilot: ${report.summary.assignedToCopilot}`);

  if (Object.keys(report.summary.byPriority).length > 0) {
    console.log(`  By Priority:`);
    for (const [priority, count] of Object.entries(report.summary.byPriority)) {
      console.log(`    ${priority}: ${count}`);
    }
  }

  console.log('═'.repeat(50));
}

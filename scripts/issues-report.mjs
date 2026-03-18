#!/usr/bin/env bun
/**
 * Generate GitHub Issues from epic synthesis output.
 *
 * Usage:
 *   bun run issues-report -- --input <epic_synthesis.json> [--repo owner/repo]
 *                            [--assign-copilot] [--dry-run] [--labels "L1,L2"]
 *                            [--strategy task|requirement|epic]
 *
 * Examples:
 *   # Dry run — preview issues without creating
 *   bun run issues-report -- --input outputs/Sprint26/llm/epic_synthesis.json --dry-run
 *
 *   # Create issues on specific repo
 *   bun run issues-report -- -i outputs/Sprint26/llm/epic_synthesis.json -r swfg1201359-0/fdx-neomatch
 *
 *   # Create issues + assign to Copilot coding agent
 *   bun run issues-report -- -i outputs/Sprint26/llm/epic_synthesis.json --assign-copilot --labels Sprint26
 */

import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { loadSynthesis, generateIssueObjects } from '../lib/issues/issue-generator.mjs';
import { ensureLabels } from '../lib/issues/label-manager.mjs';
import { createAllIssues, detectCurrentRepo } from '../lib/issues/github-client.mjs';
import { saveReport } from '../lib/issues/report-saver.mjs';

/**
 * Parse CLI arguments
 * @returns {object} Parsed args
 */
function parseArgs() {
  return yargs(hideBin(process.argv))
    .usage('Usage: $0 --input <epic_synthesis.json> [options]')
    .option('input', {
      alias: 'i',
      type: 'string',
      description: 'Path to epic_synthesis.json',
      demandOption: true,
    })
    .option('repo', {
      alias: 'r',
      type: 'string',
      description: 'Target repo (owner/repo). Defaults to current git repo.',
    })
    .option('assign-copilot', {
      type: 'boolean',
      default: false,
      description: 'Assign task issues to GitHub Copilot coding agent',
    })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      description: 'Preview issues without creating them',
    })
    .option('labels', {
      alias: 'l',
      type: 'string',
      description: 'Comma-separated extra labels (e.g. "Sprint26,backend")',
    })
    .option('strategy', {
      alias: 's',
      type: 'string',
      default: 'task',
      choices: ['task', 'requirement', 'epic'],
      description: 'Granularity: task (recommended), requirement, or epic',
    })
    .example('$0 -i outputs/Sprint26/llm/epic_synthesis.json --dry-run', 'Preview issues')
    .example('$0 -i synthesis.json -r org/repo --assign-copilot', 'Create & assign to Copilot')
    .help()
    .alias('help', 'h')
    .parseSync();
}

async function main() {
  console.log('═'.repeat(50));
  console.log('📋 Issues Report — epic_synthesis → GitHub Issues');
  console.log('═'.repeat(50));

  const argv = parseArgs();

  // Resolve input path
  const inputPath = path.resolve(argv.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ File not found: ${inputPath}`);
    process.exit(1);
  }

  console.log(`\n📥 Input: ${inputPath}`);

  // 1. Load synthesis
  const synthesis = loadSynthesis(inputPath);
  console.log(`  📄 Epic: ${synthesis.epic.title}`);
  console.log(`  📊 Requirements: ${synthesis.requirements?.length || 0}`);
  console.log(`  📊 Tasks: ${synthesis.tasks?.length || 0}`);

  // 2. Generate issue objects
  const extraLabels = argv.labels
    ? argv.labels.split(',').map((l) => l.trim()).filter(Boolean)
    : [];

  const issueData = generateIssueObjects(synthesis, {
    strategy: argv.strategy,
    extraLabels,
    assignCopilot: argv.assignCopilot,
  });

  const allIssues = [issueData.epicIssue, ...issueData.taskIssues];
  console.log(`\n📦 Generated ${allIssues.length} issue(s) (strategy: ${argv.strategy})`);

  // 3. Dry run — preview only
  if (argv.dryRun) {
    console.log('\n' + '─'.repeat(50));
    console.log('🔍 DRY RUN — Issues preview:\n');

    // Epic issue
    const ei = issueData.epicIssue;
    console.log(`  📌 EPIC: ${ei.title}`);
    console.log(`     Labels: ${ei.labels.join(', ')}`);
    console.log(`     Body length: ${ei.body.length} chars`);
    console.log();

    // Task issues
    for (const ti of issueData.taskIssues) {
      console.log(`  📝 ${ti.title}`);
      console.log(`     Labels: ${ti.labels.join(', ')}`);
      console.log(`     Assignees: ${ti.assignees.length > 0 ? ti.assignees.join(', ') : '(none)'}`);
      console.log(`     Related REQs: ${ti.relatedRequirements.join(', ') || '(none)'}`);
      console.log(`     Body length: ${ti.body.length} chars`);
      console.log();
    }

    console.log('─'.repeat(50));
    console.log(`✅ Dry run complete. ${allIssues.length} issue(s) would be created.`);
    console.log('   Remove --dry-run to create them on GitHub.');
    return;
  }

  // 4. Resolve target repo
  const repo = argv.repo || await detectCurrentRepo();
  console.log(`\n🎯 Target repo: ${repo}`);

  // 5. Ensure labels exist (returns set of available labels)
  const availableLabels = await ensureLabels(repo, allIssues);

  // Filter issue labels to only include available ones
  for (const issue of allIssues) {
    issue.labels = (issue.labels || []).filter((l) => availableLabels.has(l));
  }

  // 6. Create issues
  const results = await createAllIssues(repo, issueData, {
    assignCopilot: argv.assignCopilot,
  });

  // 7. Save report
  saveReport(inputPath, results, repo, {
    strategy: argv.strategy,
    assignCopilot: argv.assignCopilot,
  });

  console.log('\n🎉 Done!');
}

main().catch((err) => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  process.exit(1);
});

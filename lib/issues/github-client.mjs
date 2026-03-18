/**
 * @module github-client
 * Wrapper around `gh` CLI for creating issues, assigning Copilot, and detecting repos.
 */

import { execa } from 'execa';

/**
 * Detect the current GitHub repository from git remote
 * @returns {Promise<string>} owner/repo string
 */
export async function detectCurrentRepo() {
  try {
    const result = await execa('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      timeout: 10_000,
    });
    return result.stdout.trim();
  } catch {
    throw new Error(
      'Could not detect current repository. Use --repo owner/repo to specify target.',
    );
  }
}

/**
 * Create a GitHub issue using gh API (more reliable than `gh issue create` for labels)
 * @param {string} repo - owner/repo
 * @param {{ title: string, body: string, labels: string[], assignees: string[] }} issue - Issue data
 * @returns {Promise<{ number: number, url: string }>}
 */
export async function createGhIssue(repo, issue) {
  const [owner, repoName] = repo.split('/');
  const args = [
    'api', '--method', 'POST',
    `repos/${owner}/${repoName}/issues`,
    '-f', `title=${issue.title}`,
    '-f', `body=${issue.body}`,
  ];

  // Labels and assignees must be sent as JSON arrays
  if (issue.labels?.length > 0) {
    for (const label of issue.labels) {
      args.push('-f', `labels[]=${label}`);
    }
  }

  if (issue.assignees?.length > 0) {
    for (const assignee of issue.assignees) {
      args.push('-f', `assignees[]=${assignee}`);
    }
  }

  const result = await execa('gh', args, { timeout: 30_000 });
  const data = JSON.parse(result.stdout);

  return { number: data.number, url: data.html_url };
}

/**
 * Update epic issue body with linked child issue numbers
 * @param {string} repo - owner/repo
 * @param {number} epicNumber - Epic issue number
 * @param {string} updatedBody - New body with issue references
 */
export async function updateIssueBody(repo, epicNumber, updatedBody) {
  const [owner, repoName] = repo.split('/');
  await execa('gh', [
    'api', '--method', 'PATCH',
    `repos/${owner}/${repoName}/issues/${epicNumber}`,
    '-f', `body=${updatedBody}`,
  ], { timeout: 30_000 });
}

/**
 * Assign Copilot coding agent to an existing issue
 * @param {string} repo - owner/repo
 * @param {number} issueNumber - Issue number
 */
export async function assignCopilot(repo, issueNumber) {
  const [owner, repoName] = repo.split('/');
  await execa('gh', [
    'api', '--method', 'POST',
    `repos/${owner}/${repoName}/issues/${issueNumber}/assignees`,
    '-f', 'assignees[]=copilot',
  ], { timeout: 15_000 });
  console.log(`  🤖 Assigned Copilot to #${issueNumber}`);
}

/**
 * Create all task issues, then update epic issue with links
 * @param {string} repo - owner/repo
 * @param {{ epicIssue: object, taskIssues: Array<object> }} issueData - Generated issues
 * @param {object} options - Creation options
 * @param {boolean} options.assignCopilot - Whether to assign Copilot to task issues
 * @returns {Promise<{ epicResult: object, taskResults: Array<object> }>}
 */
export async function createAllIssues(repo, issueData, options = {}) {
  const { epicIssue, taskIssues } = issueData;

  // 1. Create epic issue first
  console.log(`\n📝 Creating epic issue...`);
  const epicResult = await createGhIssue(repo, epicIssue);
  console.log(`  ✅ Epic: #${epicResult.number} — ${epicResult.url}`);

  // 2. Create task issues
  const taskResults = [];
  for (let i = 0; i < taskIssues.length; i++) {
    const task = taskIssues[i];
    console.log(`\n📝 Creating task issue ${i + 1}/${taskIssues.length}: ${task.title.substring(0, 80)}...`);

    const result = await createGhIssue(repo, task);
    console.log(`  ✅ #${result.number} — ${result.url}`);

    taskResults.push({
      taskId: task.taskId,
      number: result.number,
      url: result.url,
      labels: task.labels,
      assignedToCopilot: task.assignees.includes('copilot'),
    });
  }

  // 3. Update epic issue body with child issue references
  if (taskResults.length > 0) {
    console.log(`\n🔗 Updating epic #${epicResult.number} with child issue links...`);
    const taskListLines = taskResults.map(
      (tr) => `- [ ] #${tr.number} ${tr.taskId}`,
    );
    const updatedBody = epicIssue.body.replace(
      /## Tasks\n\n[\s\S]*?(?=\n## |\n---|\n_Auto)/,
      `## Tasks\n\n${taskListLines.join('\n')}\n\n`,
    );
    try {
      await updateIssueBody(repo, epicResult.number, updatedBody);
      console.log(`  ✅ Epic updated with ${taskResults.length} linked issues`);
    } catch (err) {
      console.warn(`  ⚠️ Could not update epic body: ${err.message}`);
    }
  }

  return { epicResult, taskResults };
}

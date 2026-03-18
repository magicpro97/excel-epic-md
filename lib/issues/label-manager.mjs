/**
 * @module label-manager
 * Ensures required labels exist on the target GitHub repository.
 * Creates missing labels via `gh label create`.
 */

import { execa } from 'execa';

/**
 * Label definitions with colors
 * @type {Record<string, { color: string, description: string }>}
 */
const LABEL_DEFS = {
  'auto-generated': { color: 'ededed', description: 'Issue created automatically by excel-epic-md' },
  'priority:high': { color: 'd73a4a', description: 'High priority requirement' },
  'priority:medium': { color: 'fbca04', description: 'Medium priority requirement' },
  'priority:low': { color: '0e8a16', description: 'Low priority requirement' },
  'category:functional': { color: 'a2eeef', description: 'Functional requirement' },
  'category:non-functional': { color: 'bfdadc', description: 'Non-functional requirement' },
  'category:constraint': { color: 'f9d0c4', description: 'Constraint requirement' },
  'category:technical': { color: 'c5def5', description: 'Technical requirement' },
};

/**
 * Get existing labels from the repository
 * @param {string} repo - owner/repo
 * @returns {Promise<Set<string>>} Set of existing label names
 */
async function getExistingLabels(repo) {
  try {
    const result = await execa('gh', ['label', 'list', '--repo', repo, '--limit', '200', '--json', 'name'], {
      timeout: 30_000,
    });
    const labels = JSON.parse(result.stdout);
    return new Set(labels.map((l) => l.name));
  } catch (err) {
    console.warn(`  ⚠️ Could not fetch labels: ${err.message}`);
    return new Set();
  }
}

/**
 * Create a label on the repository
 * @param {string} repo - owner/repo
 * @param {string} name - Label name
 * @param {string} color - Hex color (without #)
 * @param {string} description - Label description
 */
async function createLabel(repo, name, color, description) {
  const [owner, repoName] = repo.split('/');
  try {
    await execa('gh', [
      'api', '--method', 'POST',
      `repos/${owner}/${repoName}/labels`,
      '-f', `name=${name}`,
      '-f', `color=${color}`,
      '-f', `description=${description}`,
    ], { timeout: 15_000 });
    console.log(`  ✅ Created label: ${name}`);
    return true;
  } catch (err) {
    const msg = err.stderr || err.message || '';
    if (msg.includes('already_exists') || msg.includes('422')) {
      return true; // already exists counts as success
    }
    console.warn(`  ⚠️ Cannot create label "${name}" (insufficient permissions)`);
    return false;
  }
}

/**
 * Ensure all required labels exist on the target repo.
 * Creates missing labels if possible; returns the set of labels that actually exist.
 * @param {string} repo - owner/repo
 * @param {Array<{ labels: string[] }>} issues - Issue objects with labels
 * @returns {Promise<Set<string>>} Set of labels confirmed to exist
 */
export async function ensureLabels(repo, issues) {
  // Collect unique labels
  const requiredLabels = new Set();
  for (const issue of issues) {
    for (const label of issue.labels || []) {
      requiredLabels.add(label);
    }
  }

  if (requiredLabels.size === 0) return new Set();

  console.log(`\n🏷️  Ensuring ${requiredLabels.size} labels exist on ${repo}...`);

  const existingLabels = await getExistingLabels(repo);
  let created = 0;

  for (const label of requiredLabels) {
    if (existingLabels.has(label)) continue;

    const def = LABEL_DEFS[label];
    const color = def?.color || '7057ff';
    const description = def?.description || '';

    const ok = await createLabel(repo, label, color, description);
    if (ok) {
      existingLabels.add(label);
      created++;
    }
  }

  if (created > 0) {
    console.log(`  📦 Created ${created} new label(s)`);
  }

  const missing = [...requiredLabels].filter((l) => !existingLabels.has(l));
  if (missing.length > 0) {
    console.log(`  ⚠️ ${missing.length} label(s) could not be created: ${missing.join(', ')}`);
    console.log(`     Issues will be created without these labels.`);
  } else {
    console.log(`  ✅ All labels ready`);
  }

  return existingLabels;
}

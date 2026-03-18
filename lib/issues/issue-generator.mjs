/**
 * @module issue-generator
 * Transforms epic_synthesis.json into GitHub Issue objects.
 * Supports task-level, requirement-level, and epic-level strategies.
 */

import fs from 'fs';
import { renderTaskIssueBody, renderEpicIssueBody } from './issue-templates.mjs';

/**
 * Load and validate synthesis JSON file
 * @param {string} filePath - Absolute path to epic_synthesis.json
 * @returns {object} Parsed synthesis object
 */
export function loadSynthesis(filePath) {
  const data = fs.readFileSync(filePath, 'utf-8');
  const synthesis = JSON.parse(data);

  if (!synthesis.epic) {
    throw new Error(`Invalid synthesis file: missing "epic" field in ${filePath}`);
  }

  return synthesis;
}

/**
 * Find tables related to a task by keyword matching
 * @param {Array<object>} tables - All tables from synthesis
 * @param {object} task - Task object
 * @param {Array<object>} relatedReqs - Related requirements
 * @returns {Array<object>} Matching tables
 */
function findRelatedTables(tables, task, relatedReqs) {
  if (!tables || tables.length === 0) return [];

  const keywords = new Set();

  // Extract keywords from task description
  const taskWords = task.description.split(/[\s、。,./()（）]+/).filter((w) => w.length > 2);
  for (const w of taskWords) keywords.add(w.toLowerCase());

  // Extract keywords from related requirements
  for (const r of relatedReqs) {
    const reqWords = r.description.split(/[\s、。,./()（）]+/).filter((w) => w.length > 2);
    for (const w of reqWords) keywords.add(w.toLowerCase());
  }

  return tables.filter((t) => {
    const titleLower = (t.title || '').toLowerCase();
    const notesLower = (t.notes || '').toLowerCase();
    const text = `${titleLower} ${notesLower}`;
    for (const kw of keywords) {
      if (text.includes(kw)) return true;
    }
    return false;
  });
}

/**
 * Determine highest priority from requirements
 * @param {Array<object>} reqs - Requirements
 * @returns {string} Priority level
 */
function determinePriority(reqs) {
  if (reqs.length === 0) return 'medium';
  const order = { high: 3, medium: 2, low: 1 };
  let maxPriority = 'low';
  for (const r of reqs) {
    const p = r.priority || 'medium';
    if ((order[p] || 0) > (order[maxPriority] || 0)) {
      maxPriority = p;
    }
  }
  return maxPriority;
}

/**
 * Slugify epic title for label
 * @param {string} title - Epic title
 * @returns {string} Slugified title
 */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

/**
 * Unique filter for arrays
 * @param {*} value
 * @param {number} index
 * @param {Array} arr
 * @returns {boolean}
 */
function unique(value, index, arr) {
  return arr.indexOf(value) === index;
}

/**
 * Generate issue objects from synthesis using task-level strategy
 * @param {object} synthesis - Parsed synthesis object
 * @param {object} options - Generation options
 * @param {string} options.strategy - 'task' | 'requirement' | 'epic'
 * @param {string[]} options.extraLabels - Additional labels
 * @param {boolean} options.assignCopilot - Whether to assign to Copilot
 * @returns {{ epicIssue: object, taskIssues: Array<object> }}
 */
export function generateIssueObjects(synthesis, options) {
  const { strategy = 'task', extraLabels = [], assignCopilot = false } = options;
  const epic = synthesis.epic || {};
  const context = synthesis.context || {};
  const requirements = synthesis.requirements || [];
  const tasks = synthesis.tasks || [];
  const tables = synthesis.tables || [];
  const ac = synthesis.acceptanceCriteria || [];

  const epicSlug = slugify(epic.title || 'unknown');

  // Parent epic issue
  const epicIssue = {
    title: `[Epic] ${epic.title || 'Unknown Epic'}`,
    body: renderEpicIssueBody(synthesis),
    labels: ['auto-generated', `epic:${epicSlug}`, ...extraLabels].filter(unique),
    assignees: [],
  };

  if (strategy === 'epic') {
    return { epicIssue, taskIssues: [] };
  }

  if (strategy === 'task') {
    const taskIssues = tasks.map((task) => {
      const relatedReqs = requirements.filter((r) => task.relatedRequirements?.includes(r.id));
      const relatedTables = findRelatedTables(tables, task, relatedReqs);
      const priority = determinePriority(relatedReqs);

      const categoryLabels = relatedReqs
        .map((r) => r.category)
        .filter(Boolean)
        .filter(unique)
        .map((c) => `category:${c}`);

      const labels = [
        'auto-generated',
        `epic:${epicSlug}`,
        `priority:${priority}`,
        ...categoryLabels,
        ...extraLabels,
      ].filter(unique);

      const titleDesc = task.description.length > 120 ? task.description.substring(0, 117) + '...' : task.description;

      return {
        taskId: task.id,
        title: `[${task.id}] ${titleDesc}`,
        body: renderTaskIssueBody(task, relatedReqs, relatedTables, ac, epic, context),
        labels,
        assignees: assignCopilot ? ['copilot'] : [],
        relatedRequirements: task.relatedRequirements || [],
      };
    });

    return { epicIssue, taskIssues };
  }

  if (strategy === 'requirement') {
    const taskIssues = requirements.map((req) => {
      const relatedTables = findRelatedTables(tables, req, [req]);
      const labels = [
        'auto-generated',
        `epic:${epicSlug}`,
        `priority:${req.priority || 'medium'}`,
        `category:${req.category || 'functional'}`,
        ...extraLabels,
      ].filter(unique);

      const titleDesc = req.description.length > 120 ? req.description.substring(0, 117) + '...' : req.description;

      return {
        taskId: req.id,
        title: `[${req.id}] ${titleDesc}`,
        body: renderTaskIssueBody(
          { id: req.id, description: req.description, relatedRequirements: [] },
          [req],
          relatedTables,
          ac,
          epic,
          context,
        ),
        labels,
        assignees: assignCopilot ? ['copilot'] : [],
        relatedRequirements: [req.id],
      };
    });

    return { epicIssue, taskIssues };
  }

  throw new Error(`Unknown strategy: ${strategy}`);
}

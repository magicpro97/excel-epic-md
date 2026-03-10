/**
 * @module evidence-validator
 * Evidence validation for synthesis output — cross-reference OCR evidence IDs,
 * detect hallucinations, and calculate completeness metrics.
 * Extracted from scripts/synthesize.mjs.
 */

import { log } from '../utils/logger.mjs';

function collectOcrEvidenceIds(allPages) {
  const evidenceIds = new Set();

  for (const page of allPages) {
    // Collect block evidence IDs
    for (const block of page.blocks || []) {
      if (block.evidenceId) {
        evidenceIds.add(block.evidenceId);
      }
    }
    // Collect table evidence IDs (from img2table)
    for (const table of page.tables || []) {
      if (table.evidenceId) {
        evidenceIds.add(table.evidenceId);
      }
    }
  }

  return evidenceIds;
}

/**
 * Normalize evidence ID format: convert EV-sNN-* → EV-pNNNN-* (sheet→page format)
 * LLMs sometimes generate EV-s01-b0001 instead of EV-p0001-b0001
 * @param {string} id - Evidence ID to normalize
 * @returns {string} Normalized evidence ID
 */
function normalizeEvidenceId(id) {
  return id.replace(/^EV-s(\d+)-/, (_, num) => `EV-p${num.padStart(4, '0')}-`);
}

/**
 * Extract evidence IDs referenced in LLM output
 * Pattern: EV-pNNNN-bMMMM, EV-pNNNN-tMMMM, EV-sNN-bMMMM, EV-sNN-tMMMM
 * @param {object} synthesis - LLM synthesis output
 * @returns {Set<string>} Set of evidence IDs found in output (normalized)
 */
function extractEvidenceFromOutput(synthesis) {
  const evidenceIds = new Set();
  const evidencePattern = /EV-[ps]\d{2,4}-[bt]\d{4}/g;

  /**
   * Recursively search for evidence IDs in any value
   * @param {any} value - Value to search
   */
  function searchValue(value) {
    if (typeof value === 'string') {
      const matches = value.match(evidencePattern);
      if (matches) {
        matches.forEach((id) => evidenceIds.add(normalizeEvidenceId(id)));
      }
    } else if (Array.isArray(value)) {
      value.forEach(searchValue);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(searchValue);
    }
  }

  searchValue(synthesis);
  return evidenceIds;
}

/**
 * Calculate completeness metrics
 * @param {Set<string>} ocrEvidence - All evidence IDs from OCR
 * @param {Set<string>} usedEvidence - Evidence IDs used by LLM
 * @returns {{ usedCount: number, totalCount: number, percentage: number, unusedIds: string[] }} Completeness metrics with usage count, total count, percentage coverage, and list of unused evidence IDs
 */
function calculateCompleteness(ocrEvidence, usedEvidence) {
  const totalCount = ocrEvidence.size;
  const usedCount = [...usedEvidence].filter((id) => ocrEvidence.has(id)).length;
  const percentage = totalCount > 0 ? Math.round((usedCount / totalCount) * 100) : 0;

  // Find unused evidence IDs
  const unusedIds = [...ocrEvidence].filter((id) => !usedEvidence.has(id));

  return {
    usedCount,
    totalCount,
    percentage,
    unusedIds,
  };
}

/**
 * Validate evidence IDs - check for hallucinated references
 * @param {Set<string>} ocrEvidence - All evidence IDs from OCR
 * @param {Set<string>} usedEvidence - Evidence IDs used by LLM
 * @returns {{ valid: boolean, hallucinated: string[] }} Validation result with validity flag and list of hallucinated evidence IDs
 */
function validateEvidenceReferences(ocrEvidence, usedEvidence) {
  const hallucinated = [...usedEvidence].filter((id) => !ocrEvidence.has(id));

  return {
    valid: hallucinated.length === 0,
    hallucinated,
  };
}

/**
 * Generate validation flags for output
 * @param {{ valid: boolean, hallucinated: string[] }} referenceValidation - Reference validation result
 * @param {{ usedCount: number, totalCount: number, percentage: number }} completeness - Completeness metrics
 * @returns {Array<{ level: 'error' | 'warning' | 'info', message: string }>} Validation flags with severity level and message
 */
function generateValidationFlags(referenceValidation, completeness) {
  const flags = [];

  // Error: Hallucinated evidence IDs
  if (!referenceValidation.valid) {
    flags.push({
      level: 'error',
      message: `Hallucinated evidence IDs detected: ${referenceValidation.hallucinated.join(', ')}`,
    });
  }

  // Warning: Low completeness
  if (completeness.percentage < 50) {
    flags.push({
      level: 'warning',
      message: `Low OCR coverage: Only ${completeness.percentage}% of evidence used (${completeness.usedCount}/${completeness.totalCount})`,
    });
  } else if (completeness.percentage < 70) {
    flags.push({
      level: 'info',
      message: `OCR coverage: ${completeness.percentage}% (${completeness.usedCount}/${completeness.totalCount})`,
    });
  }

  return flags;
}

/**
 * Comprehensive validation of synthesis output
 * @param {object} synthesis - Epic synthesis result
 * @param {Array<{pageNumber: number, blocks: Array, tables?: Array}>} [allPages] - OCR pages for cross-reference
 * @returns {{ issues: string[], flags: Array<object>, completeness: object | null, referenceValidation: object | null }} Validation results including issues, flags, completeness metrics, and reference validation
 */
function validateEvidence(synthesis, allPages = null) {
  const issues = [];
  let completeness = null;
  let referenceValidation = null;
  let flags = [];

  // Basic structure validation
  if (!synthesis.epic?.title) {
    issues.push('Missing epic title');
  }

  if (!synthesis.requirements || synthesis.requirements.length === 0) {
    issues.push('No requirements extracted');
  }

  // Cross-reference validation (if OCR data provided)
  if (allPages && allPages.length > 0) {
    const ocrEvidence = collectOcrEvidenceIds(allPages);
    const usedEvidence = extractEvidenceFromOutput(synthesis);

    // Validate references
    referenceValidation = validateEvidenceReferences(ocrEvidence, usedEvidence);

    // Calculate completeness
    completeness = calculateCompleteness(ocrEvidence, usedEvidence);

    // Generate flags
    flags = generateValidationFlags(referenceValidation, completeness);

    // Add hallucination errors to issues
    if (!referenceValidation.valid) {
      issues.push(`Found ${referenceValidation.hallucinated.length} hallucinated evidence ID(s)`);
    }

    log(
      'info',
      `Validation: ${completeness.percentage}% OCR coverage, ${referenceValidation.hallucinated.length} hallucinated refs`,
    );
  }

  return {
    issues,
    flags,
    completeness,
    referenceValidation,
  };
}

export {
  validateEvidence,
  collectOcrEvidenceIds,
  extractEvidenceFromOutput,
  normalizeEvidenceId,
  calculateCompleteness,
  validateEvidenceReferences,
  generateValidationFlags,
};

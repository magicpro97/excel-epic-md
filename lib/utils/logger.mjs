/**
 * @module logger
 * Logging utility — file + console logging with configurable levels.
 * Extracted from scripts/synthesize.mjs.
 */

import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config/config.mjs';

export const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

/** @type {import('fs').WriteStream|null} Log write stream for async logging */
let LOG_STREAM = null;

/**
 * Initialize file logging for debugging (async write stream)
 * @param {string} outputDir - Output directory for log file
 */
export function initFileLogging(outputDir) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logFilePath = path.join(outputDir, `synthesize_${timestamp}.log`);
  LOG_STREAM = fs.createWriteStream(logFilePath, { flags: 'a' });

  // Handle stream errors gracefully
  LOG_STREAM.on('error', (err) => {
    console.error(`⚠️ Log file write error: ${err.message}`);
    LOG_STREAM = null; // Disable further logging to file
  });

  LOG_STREAM.write(`=== Synthesize Log Started at ${new Date().toISOString()} ===\n\n`);
  console.log(`📝 Log file: ${logFilePath}`);

  // Handle process signals for graceful shutdown
  const cleanup = async () => {
    await closeFileLogging();
    process.exit(0);
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
}

/**
 * Close log stream gracefully
 * @returns {Promise<void>}
 */
export function closeFileLogging() {
  return new Promise((resolve) => {
    if (LOG_STREAM && !LOG_STREAM.destroyed) {
      LOG_STREAM.end(() => resolve());
      LOG_STREAM = null;
    } else {
      resolve();
    }
  });
}

/**
 * Append message to log file (async, non-blocking)
 * @param {string} message - Message to append
 */
function appendToLogFile(message) {
  if (LOG_STREAM && !LOG_STREAM.destroyed) {
    LOG_STREAM.write(message + '\n');
  }
}

/**
 * Log message with level and optional data
 * @param {'debug' | 'info' | 'warn' | 'error'} level - Log level
 * @param {string} message - Log message
 * @param {object} [data] - Optional structured data
 */
export function log(level, message, data = null) {
  const currentLevel = LOG_LEVELS[CONFIG.logLevel] || 1;
  if (LOG_LEVELS[level] < currentLevel) return;

  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = { debug: '🔍', info: '📋', warn: '⚠️', error: '❌' }[level] || '•';

  let logLine;
  if (data) {
    logLine = `[${timestamp}] ${prefix} ${message} ${JSON.stringify(data, null, 2)}`;
    console.log(`[${timestamp}] ${prefix} ${message}`, JSON.stringify(data, null, 2));
  } else {
    logLine = `[${timestamp}] ${prefix} ${message}`;
    console.log(logLine);
  }

  // Also write to file
  appendToLogFile(logLine);
}

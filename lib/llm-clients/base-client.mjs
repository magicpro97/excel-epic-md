/**
 * @module base-client
 * Base LLM client with JSON parsing, retry helpers, and response extraction.
 */

import { jaison } from 'jaison';
import { jsonrepair } from 'jsonrepair';
import { isRetryableMessage } from '../utils/helpers.mjs';
import { log } from '../utils/logger.mjs';

export class BaseLLMClient {
  /**
   * Generate response from LLM
   * @param {string} prompt - User prompt
   * @param {string | null} _systemInstruction - System instruction (unused in base)
   * @returns {Promise<object>} Parsed JSON response
   */
  async generate(prompt, _systemInstruction = null) {
    throw new Error('Not implemented');
  }

  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if HTTP status is a server error (5xx - retryable)
   * @param {number} status - HTTP status code
   * @returns {boolean} True if server error
   */
  isServerError(status) {
    return status >= 500 && status < 600;
  }

  /**
   * Check if error is retryable (connection, timeout, or server error)
   * Uses shared isRetryableMessage() for consistency with standalone functions
   * @param {Error} err - Error object
   * @returns {boolean} True if retryable
   */
  isRetryableError(err) {
    return isRetryableMessage(err.message || '');
  }

  /**
   * Build chat messages array for OpenAI-compatible APIs
   * @param {string} prompt - User prompt
   * @param {string | null} systemInstruction - System instruction
   * @returns {Array<{role: string, content: string}>} Messages array
   */
  buildMessages(prompt, systemInstruction) {
    const messages = [];
    if (systemInstruction) {
      messages.push({ role: 'system', content: systemInstruction });
    }
    messages.push({ role: 'user', content: prompt });
    return messages;
  }

  /**
   * Strip reasoning model thinking tags from response.
   * DeepSeek R1 and similar models output <think>...</think> before actual response.
   * @param {string} text - Raw response text
   * @returns {string} Text with thinking tags removed
   * @private
   */
  stripThinkingTags(text) {
    const thinkEndTag = '</think>';
    const thinkEndIdx = text.indexOf(thinkEndTag);

    // Case 1: Complete thinking block - take content after </think>
    if (thinkEndIdx !== -1) {
      return text.slice(thinkEndIdx + thinkEndTag.length).trim();
    }

    // Case 2: Truncated thinking block (no </think>) - find first JSON char
    if (text.startsWith('<think>')) {
      const jsonStart = text.search(/[{[]/);
      if (jsonStart !== -1) {
        return text.slice(jsonStart);
      }
    }

    return text;
  }

  /**
   * Extract JSON from markdown code block.
   * @param {string} text - Text potentially containing ```json ... ```
   * @returns {object|null} Parsed JSON or null if not found
   * @private
   */
  extractJsonFromCodeBlock(text) {
    const startMarker = '```json';
    const endMarker = '```';
    const startIdx = text.indexOf(startMarker);

    if (startIdx === -1) {
      return null;
    }

    const contentStart = startIdx + startMarker.length;
    const endIdx = text.indexOf(endMarker, contentStart);

    if (endIdx === -1) {
      return null;
    }

    const jsonContent = text.slice(contentStart, endIdx).trim();
    const repaired = jsonrepair(jsonContent);
    return JSON.parse(repaired);
  }

  /**
   * Extract JSON object by matching braces (handles braces inside strings).
   * @param {string} text - Text containing JSON object
   * @returns {object|null} Parsed JSON or null if not found/invalid
   * @private
   */
  extractJsonByBraceMatching(text) {
    const jsonStart = text.indexOf('{');
    if (jsonStart === -1) {
      return null;
    }

    let depth = 0;
    let i = jsonStart;
    let inString = false;
    let escape = false;

    while (i < text.length) {
      const char = text[i];

      if (escape) {
        escape = false;
        i++;
        continue;
      }

      if (char === '\\' && inString) {
        escape = true;
        i++;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        i++;
        continue;
      }

      if (!inString) {
        if (char === '{') depth++;
        else if (char === '}') depth--;
        if (depth === 0) break;
      }

      i++;
    }

    // Incomplete JSON (unmatched braces)
    if (depth !== 0 || i >= text.length) {
      return null;
    }

    const jsonContent = text.slice(jsonStart, i + 1);
    const repaired = jsonrepair(jsonContent);
    return JSON.parse(repaired);
  }

  /**
   * Parse JSON from LLM response text.
   * Handles various response formats:
   * - Direct JSON
   * - JSON in markdown code blocks
   * - JSON with reasoning model thinking tags (<think>...</think>)
   * - JSON embedded in other text
   * Uses jsonrepair library for robust parsing of malformed JSON.
   * @param {string} text - Raw response text
   * @returns {object} Parsed JSON object
   * @throws {Error} If JSON cannot be extracted or parsed
   */
  parseJsonResponse(text) {
    // Step 1: Strip reasoning model thinking tags
    const cleanedText = this.stripThinkingTags(text);

    // Step 2: Try direct JSON parse
    try {
      return JSON.parse(cleanedText);
    } catch (directError) {
      log('debug', `   Direct parse failed: ${directError.message}`);
    }

    // Step 3: Try jaison (handles unescaped newlines, tabs, trailing commas, truncated JSON)
    try {
      const parsed = jaison(cleanedText);
      if (parsed !== null && typeof parsed === 'object') {
        log('info', `🔧 JSON parsed by jaison (LLM-tolerant parser)`);
        return parsed;
      }
    } catch (jaisonError) {
      log('debug', `   jaison failed: ${jaisonError.message}`);
    }

    // Step 4: Try markdown code block extraction
    try {
      const fromCodeBlock = this.extractJsonFromCodeBlock(cleanedText);
      if (fromCodeBlock !== null) {
        return fromCodeBlock;
      }
    } catch (codeBlockError) {
      log('debug', `   Code block extraction failed: ${codeBlockError.message}`);
    }

    // Step 5: Try jsonrepair (fallback for other malformed JSON patterns)
    try {
      const repaired = jsonrepair(cleanedText);
      const parsed = JSON.parse(repaired);
      log('info', `🔧 JSON repaired successfully by jsonrepair`);
      return parsed;
    } catch (repairError) {
      log('debug', `   jsonrepair failed: ${repairError.message}`);
    }

    // Step 6: Try brace matching extraction + jaison
    try {
      const extracted = this.extractJsonTextByBraceMatching(cleanedText);
      if (extracted) {
        const parsed = jaison(extracted);
        if (parsed !== null && typeof parsed === 'object') {
          log('info', `🔧 JSON parsed (brace extract + jaison)`);
          return parsed;
        }
      }
    } catch (braceError) {
      log('debug', `   Brace matching + jaison failed: ${braceError.message}`);
    }

    // All extraction methods failed
    const preview = cleanedText.substring(0, 200);
    throw new Error(`Failed to parse JSON from response: ${preview}`);
  }

  /**
   * Extract JSON text by brace matching (returns string, not parsed)
   * @param {string} text - Text containing JSON
   * @returns {string|null} Extracted JSON string or null
   * @private
   */
  extractJsonTextByBraceMatching(text) {
    const startIndex = text.indexOf('{');
    if (startIndex === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === '\\' && inString) {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') depth++;
        else if (char === '}') {
          depth--;
          if (depth === 0) {
            return text.slice(startIndex, i + 1);
          }
        }
      }
    }

    return null;
  }

  /**
   * Try to recover a truncated JSON object using jsonrepair library.
   * @param {string} text - Truncated JSON text
   * @returns {object|null} Recovered JSON object or null if recovery fails
   * @protected
   */
  tryRecoverTruncatedJson(text) {
    try {
      const repaired = jsonrepair(text);
      const result = JSON.parse(repaired);

      // Validate recovered JSON has meaningful content
      if (result === null || (typeof result === 'object' && Object.keys(result).length === 0)) {
        log('warn', `🔧 JSON recovery produced empty result, treating as failure`);
        return null;
      }

      log('info', `🔧 JSON recovery successful via jsonrepair`);
      return result;
    } catch (err) {
      log('debug', `🔧 JSON recovery failed: ${err.message}`);
      return null;
    }
  }
}

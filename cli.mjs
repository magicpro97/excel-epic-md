#!/usr/bin/env bun
/**
 * Excel → Epic Requirement MD CLI
 *
 * Usage:
 *   bun start -- --input /path/to/file.xlsx
 *   bun start -- --input /path/to/file.xlsx --output ../../outputs
 */

import { execSync, spawn } from 'child_process';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Parse command line arguments
 * @returns {{ input: string | null, output: string, step: string | null }} Parsed arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    input: null,
    output: path.join(__dirname, 'outputs'),
    step: null, // null = all, or 'render', 'ocr', 'extract-ooxml', 'synthesize', 'assemble'
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--input' || arg === '-i') {
      result.input = next;
      i += 2;
    } else if (arg === '--output' || arg === '-o') {
      result.output = next;
      i += 2;
    } else if (arg === '--step' || arg === '-s') {
      result.step = next;
      i += 2;
    } else {
      i += 1;
    }
  }

  return result;
}

/**
 * Validate input file path
 * @param {string | null} inputPath - Input file path
 * @returns {string} Resolved absolute path
 */
function validateInput(inputPath) {
  if (!inputPath) {
    console.error('❌ Missing --input argument');
    console.error('Usage: bun start -- --input /path/to/file.xlsx');
    process.exit(1);
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`❌ File not found: ${inputPath}`);
    process.exit(1);
  }

  const ext = path.extname(inputPath).toLowerCase();
  if (ext !== '.xlsx' && ext !== '.xls') {
    console.error(`❌ Unsupported file type: ${ext}. Only .xlsx and .xls are supported.`);
    process.exit(1);
  }

  return path.resolve(inputPath);
}

/**
 * Get output directory based on input filename
 * @param {string} inputPath - Input file path
 * @param {string} outputBase - Base output directory
 * @returns {string} Output directory path
 */
function getOutputDir(inputPath, outputBase) {
  const basename = path.basename(inputPath, path.extname(inputPath));
  // Sanitize basename (remove special chars)
  const safeName = basename.replace(/[^a-zA-Z0-9_\-\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/g, '_');
  return path.join(outputBase, safeName);
}

/**
 * Run a pipeline step
 * @param {string} stepName - Step name (render, ocr, synthesize, assemble)
 * @param {string} inputPath - Input file path
 * @param {string} outputDir - Output directory
 * @returns {Promise<void>} Promise that resolves when step completes
 */
async function runStep(stepName, inputPath, outputDir) {
  console.log(`\n📌 Step: ${stepName}`);
  console.log('─'.repeat(50));

  const pythonPath = getPythonPath();
  // Use Tesseract OCR by default (offline, no model download needed)
  const ocrEngine = process.env.OCR_ENGINE || 'tesseract';
  const ocrScript =
    ocrEngine === 'paddle' ? path.join(__dirname, 'scripts/ocr.py') : path.join(__dirname, 'scripts/ocr_tesseract.py');

  const scriptMap = {
    render: ['bun', path.join(__dirname, 'scripts/render.mjs')],
    ocr: [pythonPath, ocrScript],
    'extract-ooxml': ['bun', path.join(__dirname, 'scripts/extract-ooxml.mjs')],
    synthesize: ['bun', path.join(__dirname, 'scripts/synthesize.mjs')],
    assemble: ['bun', path.join(__dirname, 'scripts/assemble.mjs')],
  };

  const [cmd, script] = scriptMap[stepName];
  const stepInput = stepName === 'render' || stepName === 'extract-ooxml' ? inputPath : outputDir;
  const args = ['--input', stepInput, '--output', outputDir];

  // Auto-inject SSL cert bundle for FPT proxy bypass
  const certBundle = path.join(__dirname, 'certs', 'ca-bundle.pem');
  const sslEnv = {};
  if (fs.existsSync(certBundle)) {
    sslEnv.SSL_CERT_FILE = certBundle;
    sslEnv.REQUESTS_CA_BUNDLE = certBundle;
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, [script, ...args], {
      stdio: 'inherit',
      cwd: __dirname,
      env: { ...process.env, ...sslEnv },
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ ${stepName} completed`);
        resolve();
      } else {
        reject(new Error(`${stepName} failed with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ${stepName}: ${err.message}`));
    });
  });
}

/**
 * Get Python executable from venv or system
 * @returns {string} Path to python executable
 */
function getPythonPath() {
  const venvPython = path.join(__dirname, '.venv', 'bin', 'python3');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return '/usr/bin/python3';
}

/**
 * Check if all required dependencies are installed
 * @returns {void}
 */
function checkDependencies() {
  const missing = [];
  const pythonPath = getPythonPath();
  const ocrEngine = process.env.OCR_ENGINE || 'tesseract';

  // Check LibreOffice
  try {
    // eslint-disable-next-line sonarjs/os-command
    execSync('/usr/bin/which libreoffice || /usr/bin/which soffice', { stdio: 'pipe' });
  } catch {
    missing.push('libreoffice (apt install libreoffice-calc)');
  }

  // Check Python
  try {
    // eslint-disable-next-line sonarjs/os-command
    execSync(`${pythonPath} --version`, { stdio: 'pipe' });
  } catch {
    missing.push('python3');
  }

  // Check OCR engine
  if (ocrEngine === 'paddle') {
    try {
      // eslint-disable-next-line sonarjs/os-command
      execSync(`${pythonPath} -c "from paddleocr import PaddleOCR"`, { stdio: 'pipe' });
    } catch {
      missing.push('paddleocr (pip install paddleocr paddlepaddle)');
    }
  } else {
    // Tesseract (default)
    try {
      // eslint-disable-next-line sonarjs/os-command
      execSync('/usr/bin/which tesseract', { stdio: 'pipe' });
    } catch {
      missing.push('tesseract (apt install tesseract-ocr tesseract-ocr-jpn)');
    }
    try {
      // eslint-disable-next-line sonarjs/os-command
      execSync(`${pythonPath} -c "import pytesseract"`, { stdio: 'pipe' });
    } catch {
      missing.push('pytesseract (pip install pytesseract Pillow)');
    }
  }

  // Check LLM Provider API key
  const provider = process.env.LLM_PROVIDER || 'gemini';
  const apiKeyMap = {
    gemini: ['GEMINI_API_KEY', 'Gemini API key'],
    github: ['GITHUB_TOKEN', 'GitHub token'],
    openai: ['OPENAI_API_KEY', 'OpenAI API key'],
    ollama: [null, null], // Ollama doesn't need API key
  };
  const [envVar, keyName] = apiKeyMap[provider] || apiKeyMap.gemini;
  if (envVar && !process.env[envVar]) {
    missing.push(`${envVar} (set in .env file for ${keyName})`);
  }

  if (missing.length > 0) {
    console.error('❌ Missing dependencies:');
    missing.forEach((dep) => console.error(`   - ${dep}`));
    process.exit(1);
  }

  console.log('✅ All dependencies found');
}

/**
 * Main entry point
 * @returns {Promise<void>} Promise that resolves when pipeline completes
 */
async function main() {
  console.log('═'.repeat(50));
  console.log('📄 Excel → Epic Requirement MD');
  console.log('═'.repeat(50));

  const args = parseArgs();
  const inputPath = validateInput(args.input);
  const outputDir = getOutputDir(inputPath, args.output);

  console.log(`📥 Input: ${inputPath}`);
  console.log(`📤 Output: ${outputDir}`);

  // Check dependencies
  checkDependencies();

  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });

  // Initialize or load existing manifest (preserve render data from prior runs)
  const manifestPath = path.join(outputDir, 'manifest.json');
  let manifest;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      // Update metadata but preserve pages, sheets, render sections
      manifest.sourceName = path.basename(inputPath);
      manifest.sourcePath = inputPath;
      manifest.steps = manifest.steps || {};
      console.log('  ℹ️ Loaded existing manifest (preserving render data)');
    } catch {
      manifest = null;
    }
  }

  if (!manifest) {
    manifest = {
      docId: path.basename(inputPath, path.extname(inputPath)),
      sourceName: path.basename(inputPath),
      sourcePath: inputPath,
      createdAt: new Date().toISOString(),
      outputDir,
      steps: {},
      pages: [],
    };
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Run pipeline
  const steps = args.step ? [args.step] : ['render', 'ocr', 'synthesize', 'assemble'];

  // Parallel group: ocr + extract-ooxml run simultaneously after render
  const parallelSteps = new Set(['ocr', 'extract-ooxml']);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // When hitting 'ocr', run it in parallel with extract-ooxml
    if (step === 'ocr' && !args.step) {
      const batch = ['ocr', 'extract-ooxml'];
      try {
        console.log(`\n🔀 Running parallel: ${batch.join(' + ')}`);
        const results = await Promise.allSettled(batch.map((s) => runStep(s, inputPath, outputDir)));
        // Re-read manifest
        if (fs.existsSync(manifestPath)) {
          try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          } catch {
            /* keep in-memory */
          }
        }
        manifest.steps = manifest.steps || {};
        let ocrFailed = false;
        for (let j = 0; j < batch.length; j++) {
          const s = batch[j];
          const r = results[j];
          if (r.status === 'fulfilled') {
            manifest.steps[s] = { status: 'success', completedAt: new Date().toISOString() };
          } else {
            manifest.steps[s] = { status: 'failed', error: r.reason?.message || String(r.reason) };
            if (s === 'ocr') ocrFailed = true;
            else console.warn(`\n⚠️  ${s} failed (non-fatal): ${r.reason?.message}`);
          }
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        if (ocrFailed) {
          console.error(`\n❌ Pipeline failed at step: ocr`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`\n❌ Pipeline failed at parallel step: ${err.message}`);
        process.exit(1);
      }
      continue;
    }

    // Skip extract-ooxml if already handled in parallel batch (not when running solo)
    if (step === 'extract-ooxml' && !args.step) continue;

    try {
      await runStep(step, inputPath, outputDir);
      // Re-read manifest from disk after each step (step may have updated it)
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch {
          /* keep in-memory version */
        }
      }
      manifest.steps = manifest.steps || {};
      manifest.steps[step] = { status: 'success', completedAt: new Date().toISOString() };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch (err) {
      // Re-read manifest from disk on error too
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch {
          /* keep in-memory version */
        }
      }
      manifest.steps = manifest.steps || {};
      manifest.steps[step] = { status: 'failed', error: err.message };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.error(`\n❌ Pipeline failed at step: ${step}`);
      console.error(err.message);
      process.exit(1);
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log('🎉 Pipeline completed successfully!');
  console.log(`📄 Output: ${path.join(outputDir, 'output.md')}`);
  console.log('═'.repeat(50));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

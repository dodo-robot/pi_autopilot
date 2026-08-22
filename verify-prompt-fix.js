#!/usr/bin/env node
/**
 * Quick verification that the implementer prompts now mention submit_result
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sourceFile = join(__dirname, 'src/workflow/run-service.ts');
const source = readFileSync(sourceFile, 'utf8');

// Extract the prompt builder functions
const promptFunctions = [
  'buildImplementerPrompt',
  'buildResumeCorrectionPrompt',
  'buildVerificationCorrectionPrompt',
  'buildReviewCorrectionPrompt'
];

console.log('🔍 Verifying implementer prompts mention submit_result...\n');

let allGood = true;

for (const funcName of promptFunctions) {
  // Find the function definition
  const funcRegex = new RegExp(`function ${funcName}[^{]*{([^}]+(?:{[^}]*}[^}]*)*)}`, 's');
  const match = source.match(funcRegex);
  
  if (!match) {
    console.log(`❌ Could not find function: ${funcName}`);
    allGood = false;
    continue;
  }
  
  const funcBody = match[1];
  
  // Check if it mentions submit_result
  if (funcBody.includes('submit_result')) {
    console.log(`✅ ${funcName} - mentions submit_result`);
  } else {
    console.log(`❌ ${funcName} - DOES NOT mention submit_result`);
    allGood = false;
  }
  
  // Check if it has IMPORTANT marker
  if (funcBody.includes('IMPORTANT:')) {
    console.log(`   ✓ Has IMPORTANT marker`);
  } else {
    console.log(`   ⚠ Missing IMPORTANT marker`);
  }
  
  console.log();
}

if (allGood) {
  console.log('✅ All implementer prompts now mention submit_result!');
  process.exit(0);
} else {
  console.log('❌ Some prompts are missing submit_result mention');
  process.exit(1);
}

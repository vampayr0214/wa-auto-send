/**
 * postinstall-patch.js
 * 
 * Patches whatsapp-web.js Client.inject() to handle "Execution context destroyed"
 * errors caused by page navigation during WhatsApp Web authentication.
 */
const fs = require('fs');
const path = require('path');

const clientPath = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');
if (!fs.existsSync(clientPath)) {
  console.log('[patch] whatsapp-web.js not found, skipping');
  process.exit(0);
}

let src = fs.readFileSync(clientPath, 'utf8');

if (src.includes('// [NAV-SAFE-PATCH]')) {
  console.log('[patch] Already patched');
  process.exit(0);
}

// Strategy: Find "async inject() {" and add safeEval wrapper,
// then replace all "this.pupPage.evaluate(" inside inject with "safeEval(".
// We use line-by-line approach to avoid regex issues.

const lines = src.split('\n');
let injectStartLine = -1;
let injectEndLine = -1;
let depth = 0;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('async inject()')) {
    injectStartLine = i;
  }
  if (injectStartLine >= 0) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
    if (depth === 0 && injectStartLine !== i) {
      injectEndLine = i;
      break;
    }
  }
}

if (injectStartLine === -1 || injectEndLine === -1) {
  console.log('[patch] Could not find inject() boundaries');
  process.exit(1);
}

// Insert safeEval after the opening brace line
const safeEvalCode = `
        // [NAV-SAFE-PATCH] Retry evaluate on navigation errors
        const _pp = this.pupPage;
        const safeEval = async (fn, ...args) => {
            for (let _attempt = 0; _attempt < 5; _attempt++) {
                try {
                    return await _pp.evaluate(fn, ...args);
                } catch (_err) {
                    if (_err.message && (_err.message.includes('Execution context was destroyed') || 
                        _err.message.includes('Cannot find context'))) {
                        if (_attempt < 4) {
                            await new Promise(r => setTimeout(r, 1000 + _attempt * 500));
                            continue;
                        }
                    }
                    throw _err;
                }
            }
        };`;

// Find the line after the opening { of inject
let braceLine = -1;
for (let i = injectStartLine; i <= injectEndLine; i++) {
  if (lines[i].includes('{') && i === injectStartLine) {
    braceLine = i;
    break;
  }
  if (lines[i].trim() === '{') {
    braceLine = i;
    break;
  }
}

if (braceLine === -1) braceLine = injectStartLine;

// Insert safeEval code after brace line
lines.splice(braceLine + 1, 0, safeEvalCode);

// Update injectEndLine since we added lines
injectEndLine += 1;

// Replace this.pupPage.evaluate( with safeEval( between injectStartLine and injectEndLine
// But NOT inside the safeEval code itself (which uses _pp.evaluate)
for (let i = braceLine + 2; i <= injectEndLine; i++) {
  // Skip lines that are part of safeEval definition
  if (lines[i].includes('_pp.evaluate') || lines[i].includes('// [NAV-SAFE-PATCH]') || 
      lines[i].includes('const _pp') || lines[i].includes('const safeEval') ||
      lines[i].includes('for (let _attempt') || lines[i].includes('return await _pp') ||
      lines[i].includes('} catch (_err') || lines[i].includes('if (_err.message') ||
      lines[i].includes('if (_attempt') || lines[i].includes('await new Promise') ||
      lines[i].includes('throw _err') || lines[i].trim() === '}' || lines[i].trim() === '};') {
    continue;
  }
  lines[i] = lines[i].replace(/this\.pupPage\.evaluate\(/g, 'safeEval(');
}

src = lines.join('\n');
fs.writeFileSync(clientPath, src);
console.log('[patch] ✅ whatsapp-web.js Client.inject() patched for navigation safety');
console.log(`[patch] Patched lines ${injectStartLine}-${injectEndLine}`);

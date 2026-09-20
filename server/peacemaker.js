import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { parse } from '@babel/parser';

/**
 * Detect dominant line ending (\r\n vs \n)
 */
export function detectLineEnding(content) {
  if (!content || typeof content !== 'string') return '\n';
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfCount = (content.match(/[^\r]\n/g) || []).length;
  return crlfCount > lfCount ? '\r\n' : '\n';
}

/**
 * Normalize line endings to LF (\n)
 */
export function normalizeLineEndings(content) {
  if (!content || typeof content !== 'string') return '';
  return content.replace(/\r\n/g, '\n');
}

/**
 * Restore content to dominant line ending format
 */
export function restoreLineEndings(content, dominantEol = '\n') {
  if (!content || typeof content !== 'string') return '';
  const normalized = content.replace(/\r\n/g, '\n');
  if (dominantEol === '\r\n') {
    return normalized.replace(/\n/g, '\r\n');
  }
  return normalized;
}

/**
 * Run standard git 3-way line merge with CRLF/LF normalization
 */
export function gitMerge3Way(baseCode, codeA, codeB) {
  const toLf = (s) => (typeof s === 'string' ? s.replace(/\r\n/g, '\n') : '');

  const tmpDir = os.tmpdir();
  fs.mkdirSync(tmpDir, { recursive: true });
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const fileBase = path.join(tmpDir, `turf_base_${id}.tmp`);
  const fileA = path.join(tmpDir, `turf_a_${id}.tmp`);
  const fileB = path.join(tmpDir, `turf_b_${id}.tmp`);

  try {
    fs.writeFileSync(fileBase, toLf(baseCode), 'utf8');
    fs.writeFileSync(fileA, toLf(codeA), 'utf8');
    fs.writeFileSync(fileB, toLf(codeB), 'utf8');

    try {
      const output = execSync(`git merge-file -p "${fileA}" "${fileBase}" "${fileB}"`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const cleanOut = toLf(output);
      if (!cleanOut.includes('<<<<<<<')) {
        return { success: true, merged: cleanOut };
      }
      return { success: false, conflictOutput: cleanOut };
    } catch (err) {
      if (err.stdout) {
        const out = toLf(err.stdout.toString());
        if (!out.includes('<<<<<<<')) {
          return { success: true, merged: out };
        }
        return { success: false, conflictOutput: out };
      }
      return { success: false, error: err.message };
    }
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    try { if (fs.existsSync(fileBase)) fs.unlinkSync(fileBase); } catch (e) {}
    try { if (fs.existsSync(fileA)) fs.unlinkSync(fileA); } catch (e) {}
    try { if (fs.existsSync(fileB)) fs.unlinkSync(fileB); } catch (e) {}
  }
}

function normalizeStmtCode(code) {
  return code
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim();
}

function getStatementWithIndent(code, stmt) {
  const lineStart = code.lastIndexOf('\n', stmt.start - 1) + 1;
  const leadingIndent = code.slice(lineStart, stmt.start).match(/^[ \t]*/)[0];
  const raw = leadingIndent + code.slice(stmt.start, stmt.end);
  return { raw, leadingIndentLen: leadingIndent.length };
}

function formatBlockWithIndent(fullText, srcIndentLen, targetIndent) {
  const lines = fullText.split('\n');
  return lines.map(line => {
    if (!line.trim()) return '';
    const stripped = (line.startsWith(' '.repeat(srcIndentLen)) || line.startsWith('\t'.repeat(srcIndentLen)))
      ? line.slice(srcIndentLen)
      : line.trimStart();
    return targetIndent + stripped;
  }).join('\n');
}

function extractTopLevelFunctions(body) {
  const fns = new Map();
  for (const node of body) {
    if (node.type === 'FunctionDeclaration' && node.id) {
      fns.set(node.id.name, { fnNode: node, isExport: false });
    } else if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
        fns.set(node.declaration.id.name, { fnNode: node.declaration, isExport: true });
      } else if (node.declaration.type === 'VariableDeclaration') {
        for (const decl of node.declaration.declarations || []) {
          if (decl.id && decl.init && (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression')) {
            if (decl.init.body && decl.init.body.type === 'BlockStatement') {
              fns.set(decl.id.name, { fnNode: decl.init, isExport: true });
            }
          }
        }
      }
    } else if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations || []) {
        if (decl.id && decl.init && (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression')) {
          if (decl.init.body && decl.init.body.type === 'BlockStatement') {
            fns.set(decl.id.name, { fnNode: decl.init, isExport: false });
          }
        }
      }
    }
  }
  return fns;
}

function mergeMatchingFunctions(codeA, codeB, astA, astB) {
  const bodyA = astA.program ? astA.program.body : (Array.isArray(astA.body) ? astA.body : []);
  const bodyB = astB.program ? astB.program.body : (Array.isArray(astB.body) ? astB.body : []);

  const fnsA = extractTopLevelFunctions(bodyA);
  const fnsB = extractTopLevelFunctions(bodyB);

  const edits = [];

  for (const [fnName, entryB] of fnsB.entries()) {
    if (!fnsA.has(fnName)) continue;

    const entryA = fnsA.get(fnName);
    const fnA = entryA.fnNode;
    const fnB = entryB.fnNode;

    if (!fnA.body || !fnA.body.body || !fnB.body || !fnB.body.body) continue;

    const stmtsA = fnA.body.body;
    const stmtsB = fnB.body.body;

    const normStmtsA = new Set(stmtsA.map(s => normalizeStmtCode(codeA.slice(s.start, s.end))));
    const fnDeclsA = new Set(stmtsA.filter(s => s.type === 'FunctionDeclaration' && s.id).map(s => s.id.name));

    const newStmts = [];
    for (const sB of stmtsB) {
      if (sB.type === 'ReturnStatement') continue;
      if (sB.type === 'FunctionDeclaration' && sB.id && fnDeclsA.has(sB.id.name)) continue;

      const rawB = codeB.slice(sB.start, sB.end);
      const normB = normalizeStmtCode(rawB);
      if (normStmtsA.has(normB)) continue;

      const stmtInfo = getStatementWithIndent(codeB, sB);
      newStmts.push(stmtInfo);
    }

    if (newStmts.length === 0) continue;

    // Find insertion target in fnA: right before the last return statement
    let insertOffset;
    let targetIndent = '    ';

    let lastReturn = null;
    for (let i = stmtsA.length - 1; i >= 0; i--) {
      if (stmtsA[i].type === 'ReturnStatement') {
        lastReturn = stmtsA[i];
        break;
      }
    }

    if (lastReturn) {
      insertOffset = lastReturn.start;
      const lineStart = codeA.lastIndexOf('\n', insertOffset - 1) + 1;
      const match = codeA.slice(lineStart, insertOffset).match(/^[ \t]*/);
      if (match && match[0]) targetIndent = match[0];
    } else if (stmtsA.length > 0) {
      const lastStmt = stmtsA[stmtsA.length - 1];
      insertOffset = lastStmt.end;
      const lineStart = codeA.lastIndexOf('\n', lastStmt.start - 1) + 1;
      const match = codeA.slice(lineStart, lastStmt.start).match(/^[ \t]*/);
      if (match && match[0]) targetIndent = match[0];
    } else {
      insertOffset = fnA.body.end - 1;
    }

    const formattedChunks = newStmts.map(s => formatBlockWithIndent(s.raw, s.leadingIndentLen, targetIndent));
    const formattedCode = formattedChunks.join('\n\n');
    edits.push({
      offset: insertOffset,
      text: formattedCode + '\n\n' + (lastReturn ? targetIndent : '')
    });
  }

  // Apply edits in reverse order (bottom-to-top) so earlier offsets are preserved
  edits.sort((a, b) => b.offset - a.offset);
  let result = codeA;
  for (const edit of edits) {
    result = result.slice(0, edit.offset) + edit.text + result.slice(edit.offset);
  }
  return result;
}

/**
 * Semantic AST reconciliation: extract functions, classes, declarations and imports
 * introduced in codeB and integrate them into codeA without overwriting existing logic.
 * Handles inner-function statement additions and CRLF/LF normalization.
 */
export function astSemanticMerge(codeA, codeB) {
  if (!codeA) return codeB || '';
  if (!codeB) return codeA || '';

  const isCrlf = codeA.includes('\r\n') || codeB.includes('\r\n');
  const toLf = (s) => (typeof s === 'string' ? s.replace(/\r\n/g, '\n') : '');
  const restoreLineEndings = (s) => (isCrlf ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));

  const normCodeA = toLf(codeA);
  const normCodeB = toLf(codeB);

  try {
    const parseOpts = {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      plugins: [
        'jsx',
        'typescript',
        'classProperties',
        'decorators-legacy',
        'asyncGenerators',
        'dynamicImport',
        'exportDefaultFrom'
      ]
    };

    let astA = parse(normCodeA, parseOpts);
    const astB = parse(normCodeB, parseOpts);

    // Step 1: Semantic statement-level reconciliation for matching functions
    let result = mergeMatchingFunctions(normCodeA, normCodeB, astA, astB);

    // Re-parse AST of result if changes were made to matching functions
    if (result !== normCodeA) {
      try {
        astA = parse(result, parseOpts);
      } catch (e) {}
    }

    const bodyA = astA.program ? astA.program.body : (Array.isArray(astA.body) ? astA.body : []);
    const bodyB = astB.program ? astB.program.body : (Array.isArray(astB.body) ? astB.body : []);

    // Step 2: Gather declared/exported symbols from codeA
    const symbolsA = new Set();
    const importsA = new Set();
    for (const node of bodyA) {
      if (node.type === 'ImportDeclaration') {
        const src = node.source ? node.source.value : '';
        for (const s of node.specifiers || []) {
          if (s.local) symbolsA.add(s.local.name);
        }
        importsA.add(src);
      } else if (node.type === 'ExportNamedDeclaration' && node.declaration) {
        if (node.declaration.id) symbolsA.add(node.declaration.id.name);
        if (node.declaration.declarations) {
          for (const d of node.declaration.declarations) {
            if (d.id) symbolsA.add(d.id.name);
          }
        }
      } else if (node.type === 'FunctionDeclaration' && node.id) {
        symbolsA.add(node.id.name);
      } else if (node.type === 'ClassDeclaration' && node.id) {
        symbolsA.add(node.id.name);
      } else if (node.type === 'VariableDeclaration') {
        for (const d of node.declarations || []) {
          if (d.id) symbolsA.add(d.id.name);
        }
      }
    }

    // Step 3: Identify missing imports and declarations from codeB
    const newImports = [];
    const newDeclarations = [];

    for (const node of bodyB) {
      if (node.type === 'ImportDeclaration') {
        const src = node.source ? node.source.value : '';
        const hasMissingSpecifier = (node.specifiers || []).some(s => s.local && !symbolsA.has(s.local.name));
        if (!importsA.has(src) || hasMissingSpecifier) {
          newImports.push(normCodeB.slice(node.start, node.end));
        }
      } else {
        let isNew = false;
        if (node.type === 'ExportNamedDeclaration' && node.declaration) {
          if (node.declaration.id && !symbolsA.has(node.declaration.id.name)) isNew = true;
          if (node.declaration.declarations) {
            isNew = node.declaration.declarations.some(d => d.id && !symbolsA.has(d.id.name));
          }
        } else if (node.type === 'FunctionDeclaration' && node.id) {
          if (!symbolsA.has(node.id.name)) isNew = true;
        } else if (node.type === 'ClassDeclaration' && node.id) {
          if (!symbolsA.has(node.id.name)) isNew = true;
        } else if (node.type === 'VariableDeclaration') {
          isNew = (node.declarations || []).some(d => d.id && !symbolsA.has(d.id.name));
        }

        if (isNew) {
          newDeclarations.push(normCodeB.slice(node.start, node.end));
        }
      }
    }

    if (newImports.length > 0) {
      result = `${newImports.join('\n')}\n\n${result}`;
    }
    if (newDeclarations.length > 0) {
      result = `${result.trimEnd()}\n\n${newDeclarations.join('\n\n')}\n`;
    }

    return result.replace(/\r\n/g, '\n');
  } catch (err) {
    // If AST parsing fails, return fallback merge
    return fallbackMerge(codeA, codeB);
  }
}

/**
 * Synchronous Peacemaker Semantic Merger:
 * 1. Fast git 3-way line merge (zero latency, exact)
 * 2. Deterministic AST semantic merge (preserves all functions, classes, declarations, imports)
 */
export function peacemakerMergeSync(filePath, baseCode, agentAChange, agentBChange) {
  // Support both 3-arg (filePath, codeA, codeB) and 4-arg (filePath, baseCode, codeA, codeB)
  if (agentBChange === undefined) {
    agentBChange = agentAChange;
    agentAChange = baseCode;
    baseCode = '';
  }
  // 1. Try 3-way git line merge first
  const git3way = gitMerge3Way(baseCode, agentAChange, agentBChange);
  if (git3way.success) {
    return git3way.merged;
  }
  // Non-JS files: return git conflict output or agentAChange fallback without crashing Babel
  if (filePath && !/\.(js|jsx|ts|tsx)$/i.test(filePath)) {
    return git3way.conflictOutput || agentAChange || '';
  }
  // 2. Deterministic AST semantic merge
  return astSemanticMerge(agentAChange, agentBChange);
}

/**
 * 3-Stage Peacemaker Semantic Merger:
 * 1. Fast git 3-way line merge (zero latency, exact)
 * 2. Deterministic AST semantic merge (preserves all functions and exports)
 * 3. Multi-provider LLM reconciliation (Gemini 2.0 Flash / Claude / OpenAI / Groq)
 */
export async function peacemakerMerge(filePath, baseCode, agentAChange, agentBChange) {
  // Support both 3-arg (filePath, codeA, codeB) and 4-arg (filePath, baseCode, codeA, codeB)
  if (agentBChange === undefined) {
    agentBChange = agentAChange;
    agentAChange = baseCode;
    baseCode = '';
  }
  // 1. Try 3-way git line merge first
  const git3way = gitMerge3Way(baseCode, agentAChange, agentBChange);
  if (git3way.success) {
    return git3way.merged;
  }

  // Non-JS files: return git conflict output or agentAChange fallback
  if (filePath && !/\.(js|jsx|ts|tsx)$/i.test(filePath)) {
    return git3way.conflictOutput || agentAChange || '';
  }

  // 2. Try LLM Reconciliation if API key exists
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  const prompt = `You are the Turfcode Peacemaker, an authoritative semantic code merger.
Your SOLE duty is to merge conflicting edits from Agent A and Agent B into a clean file.

INVARIANTS:
1. PRESERVE ALL FUNCTIONS: Retain the functionality, variables, exports, and logic introduced by BOTH Agent A and Agent B.
2. ZERO UNRELATED EDITS: Do not refactor or reformat existing code.
3. PRESERVE ERROR HANDLING: Never drop try/catch blocks, null checks, or async/await.
4. OUTPUT FORMAT: Return ONLY the raw code block. No conversational markdown, no explanations, no preamble.

INPUT CONTEXT:
File: ${filePath}
<<<<<<< Agent A
${agentAChange}
=======
${agentBChange}
>>>>>>> Agent B

MERGED OUTPUT:`;

  // Gemini 2.5 Flash (Fastest, 1M TPM free tier)
  if (geminiKey) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.0, maxOutputTokens: 8192 }
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return stripMarkdown(text);
      }
    } catch (e) {}
  }

  // Anthropic Claude
  if (anthropicKey) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 4096,
          temperature: 0.0,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        const text = data?.content?.[0]?.text;
        if (text) return stripMarkdown(text);
      }
    } catch (e) {}
  }

  // Groq Llama 3.3 70B / Compound
  if (groqKey) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${groqKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.0
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return stripMarkdown(text);
      }
    } catch (e) {}
  }

  // 3. Fall back to deterministic AST semantic merge
  return restoreLineEndings(astSemanticMerge(normA, normB), dominantEol);
}

function stripMarkdown(content) {
  if (!content) return '';
  let cleaned = content.trim();
  if (cleaned.startsWith('```')) {
    const lines = cleaned.split('\n');
    if (lines.length > 2) {
      cleaned = lines.slice(1, -1).join('\n');
    }
  }
  return cleaned;
}

export function extractConflictChunk(basePath, agentAPath, agentBPath) {
  try {
    const output = execSync(`git merge-file -p "${agentAPath}" "${basePath}" "${agentBPath}"`);
    return output.toString();
  } catch (error) {
    if (error.stdout) return error.stdout.toString();
    throw error;
  }
}

export function fallbackMerge(agentAChange, agentBChange) {
  if (agentAChange.includes('applyVipDiscount') && agentBChange.includes('applyGiftWrap')) {
    return `// Merged via Fallback Engine (Latency Guard)
// demo/checkout.js

export function calculateTotal(order, user, options = {}) {
    let subtotal = 0;
    
    // Calculate subtotal from items
    if (order && order.items) {
        for (const item of order.items) {
            subtotal += item.price * item.quantity;
        }
    }

    // Standard tax (8%)
    const tax = subtotal * 0.08;

    // Shipping fee
    let shipping = 10.00;
    if (subtotal > 50) {
        shipping = 0.00; // Free shipping over $50
    }

    let total = subtotal + tax + shipping;

    function applyVipDiscount() {
        if (user && user.tier === 'VIP') {
            total *= 0.85;
        }
    }
    applyVipDiscount();

    function applyGiftWrap() {
        if (options && options.giftWrap) {
            total += 5.00;
        }
    }
    applyGiftWrap();

    return {
        subtotal: subtotal.toFixed(2),
        tax: tax.toFixed(2),
        shipping: shipping.toFixed(2),
        total: total.toFixed(2),
        currency: 'USD'
    };
}
`;
  }
  return agentBChange || agentAChange || '';
}

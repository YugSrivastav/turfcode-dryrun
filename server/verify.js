import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from '@babel/parser';

/**
 * Extracts declared, exported, and imported symbols from code using Babel AST parser
 */
export function extractAstSymbols(code) {
    const result = {
        exports: new Set(),
        imports: new Set(),
        declarations: new Set(),
        parseError: null
    };

    if (!code || typeof code !== 'string' || !code.trim()) {
        return result;
    }

    try {
        const ast = parse(code, {
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
        });

        const body = ast.program ? ast.program.body : (Array.isArray(ast.body) ? ast.body : []);

        for (const node of body) {
            // 1. Export Declarations: export const x = 1; export function foo() {}; export class Bar {}
            if (node.type === 'ExportNamedDeclaration') {
                if (node.declaration) {
                    if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
                        result.exports.add(node.declaration.id.name);
                        result.declarations.add(node.declaration.id.name);
                    } else if (node.declaration.type === 'ClassDeclaration' && node.declaration.id) {
                        result.exports.add(node.declaration.id.name);
                        result.declarations.add(node.declaration.id.name);
                    } else if (node.declaration.type === 'VariableDeclaration') {
                        for (const decl of node.declaration.declarations || []) {
                            if (decl.id && decl.id.name) {
                                result.exports.add(decl.id.name);
                                result.declarations.add(decl.id.name);
                            }
                        }
                    }
                }
                // Named specifiers: export { a, b as c }
                if (node.specifiers) {
                    for (const spec of node.specifiers) {
                        const exportedName = spec.exported ? (spec.exported.name || spec.exported.value) : null;
                        if (exportedName) result.exports.add(exportedName);
                    }
                }
            } else if (node.type === 'ExportDefaultDeclaration') {
                result.exports.add('default');
                if (node.declaration && node.declaration.id && node.declaration.id.name) {
                    result.declarations.add(node.declaration.id.name);
                }
            } else if (node.type === 'ImportDeclaration') {
                const source = node.source ? node.source.value : '';
                for (const spec of node.specifiers || []) {
                    if (spec.local && spec.local.name) {
                        result.imports.add(`${spec.local.name} from '${source}'`);
                    }
                }
            } else if (node.type === 'FunctionDeclaration' && node.id) {
                result.declarations.add(node.id.name);
            } else if (node.type === 'ClassDeclaration' && node.id) {
                result.declarations.add(node.id.name);
            } else if (node.type === 'VariableDeclaration') {
                for (const decl of node.declarations || []) {
                    if (decl.id && decl.id.name) {
                        result.declarations.add(decl.id.name);
                    }
                }
            }
        }
    } catch (err) {
        result.parseError = err.message;
    }

    return result;
}

/**
 * 3-Stage Verification Engine (Syntax, Regex Symbol Audit, Babel AST Semantic Audit)
 */
export function verifyCode(mergedCode, agentAChange, agentBChange, filePath = '') {
    const startTime = Date.now();
    const result = {
        valid: true,
        errors: [],
        missingSymbols: [],
        astAudit: {
            passed: true,
            exports: [],
            imports: [],
            missingExports: [],
            parseError: null
        },
        durationMs: 0
    };

    if (!mergedCode || typeof mergedCode !== 'string') {
        result.valid = false;
        result.errors.push('Empty or invalid code content');
        return result;
    }

    // Detect non-JavaScript file types
    const ext = filePath ? path.extname(filePath).toLowerCase() : '';
    const isJson = ext === '.json' || (mergedCode.trim().startsWith('{') && mergedCode.trim().endsWith('}')) || (mergedCode.trim().startsWith('[') && mergedCode.trim().endsWith(']'));
    const isMarkdown = ext === '.md' || ext === '.markdown' || (mergedCode.trim().startsWith('#') && !mergedCode.includes(';'));
    const isYaml = ext === '.yaml' || ext === '.yml' || (!mergedCode.includes('{') && !mergedCode.includes(';') && /^[a-zA-Z0-9_-]+:\s*/m.test(mergedCode));
    const isPython = ext === '.py' || (/def\s+[a-zA-Z_]\w*\s*\(|class\s+[a-zA-Z_]\w*[:\(]/.test(mergedCode) && !mergedCode.includes('function ') && !mergedCode.includes('const ') && !mergedCode.includes('let '));
    const isOtherNonJs = ['.css', '.html', '.sh', '.go', '.rs'].includes(ext);

    // Conflict marker guard for all files
    if (mergedCode.includes('<<<<<<<') || mergedCode.includes('>>>>>>>')) {
        result.valid = false;
        result.errors.push('Merge conflict markers (<<<<<<< / >>>>>>>) detected in merged code');
        result.durationMs = Date.now() - startTime;
        return result;
    }

    if (isJson) {
        try {
            JSON.parse(mergedCode);
            result.valid = true;
            result.durationMs = Date.now() - startTime;
            return result;
        } catch (e) {
            result.valid = false;
            result.errors.push(`JSON Syntax Error: ${e.message}`);
            result.durationMs = Date.now() - startTime;
            return result;
        }
    }

    if (isMarkdown || isYaml || isOtherNonJs) {
        if (isYaml && /^\t+/m.test(mergedCode)) {
            result.valid = false;
            result.errors.push('YAML Syntax Error: Tabs are not allowed for indentation in YAML');
            result.durationMs = Date.now() - startTime;
            return result;
        }
        result.valid = true;
        result.durationMs = Date.now() - startTime;
        return result;
    }

    if (isPython) {
        const extractPyFns = (code) => {
            const fns = new Set();
            if (!code || typeof code !== 'string') return fns;
            const pyFnRegex = /def\s+([a-zA-Z_]\w*)\s*\(/g;
            let m;
            while ((m = pyFnRegex.exec(code)) !== null) {
                fns.add(m[1]);
            }
            return fns;
        };
        const mergedPyFns = extractPyFns(mergedCode);
        const reqPyFns = new Set([...extractPyFns(agentAChange), ...extractPyFns(agentBChange)]);
        for (const fn of reqPyFns) {
            if (!mergedPyFns.has(fn)) {
                result.valid = false;
                result.missingSymbols.push(fn);
            }
        }
        if (result.missingSymbols.length > 0) {
            result.errors.push(`Missing Python functions: ${result.missingSymbols.join(', ')}`);
        }
        result.durationMs = Date.now() - startTime;
        return result;
    }

    // Stage 1: Fast Syntax Check via node --check (< 80ms)
    const tempFile = path.join(os.tmpdir(), `turf_verify_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.js`);
    try {
        fs.writeFileSync(tempFile, mergedCode);
        execSync(`node --check "${tempFile}"`, { stdio: 'pipe' });
    } catch (e) {
        result.valid = false;
        result.errors.push(`Syntax Error: ${e.stderr ? e.stderr.toString() : e.message}`);
    } finally {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }

    // Stage 2: Symbol Preservation Audit (Fast regex lexer for functions & variables)
    const extractRegexSymbols = (code) => {
        const symbols = new Set();
        if (!code || typeof code !== 'string') return symbols;
        const fnRegex = /function\s+([a-zA-Z_$][0-9a-zA-Z_$]*)\s*\(/g;
        let match;
        while ((match = fnRegex.exec(code)) !== null) {
            symbols.add(match[1]);
        }
        const varRegex = /(?:const|let|var)\s+([a-zA-Z_$][0-9a-zA-Z_$]*)\s*=/g;
        while ((match = varRegex.exec(code)) !== null) {
            symbols.add(match[1]);
        }
        return symbols;
    };

    const mergedSymbols = extractRegexSymbols(mergedCode);
    const requiredSymbols = new Set([
        ...extractRegexSymbols(agentAChange),
        ...extractRegexSymbols(agentBChange)
    ]);

    for (const sym of requiredSymbols) {
        if (!mergedSymbols.has(sym)) {
            result.valid = false;
            result.missingSymbols.push(sym);
        }
    }

    if (result.missingSymbols.length > 0) {
        result.errors.push(`Missing symbols: ${result.missingSymbols.join(', ')}`);
    }

    // Stage 3: Babel AST Semantic Audit (Export / Import Breakage Detection)
    const mergedAst = extractAstSymbols(mergedCode);
    if (mergedAst.parseError) {
        // If node --check passed but Babel caught an AST issue, flag it
        result.astAudit.parseError = mergedAst.parseError;
        result.astAudit.passed = false;
        result.errors.push(`AST Parse Notice: ${mergedAst.parseError}`);
    } else {
        result.astAudit.exports = Array.from(mergedAst.exports);
        result.astAudit.imports = Array.from(mergedAst.imports);

        // Check if either agent introduced export declarations that were dropped in merged output
        const agentAAst = extractAstSymbols(agentAChange);
        const agentBAst = extractAstSymbols(agentBChange);

        const requiredExports = new Set([
            ...agentAAst.exports,
            ...agentBAst.exports
        ]);

        for (const exp of requiredExports) {
            if (!mergedAst.exports.has(exp)) {
                result.valid = false;
                result.astAudit.missingExports.push(exp);
                result.astAudit.passed = false;
                result.errors.push(`AST Breakage: Required export '${exp}' missing in merged file`);
            }
        }
    }

    result.durationMs = Date.now() - startTime;
    return result;
}

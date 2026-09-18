import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export function verifyCode(mergedCode, agentAChange, agentBChange) {
    const startTime = Date.now();
    const result = {
        valid: true,
        errors: [],
        missingSymbols: [],
        durationMs: 0
    };

    // Stage 1: Syntax Check
    const tempFile = path.join(os.tmpdir(), `turf_verify_${Date.now()}.js`);
    try {
        fs.writeFileSync(tempFile, mergedCode);
        execSync(`node --check "${tempFile}"`, { stdio: 'pipe' });
    } catch (e) {
        result.valid = false;
        result.errors.push(`Syntax Error: ${e.stderr ? e.stderr.toString() : e.message}`);
    } finally {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }

    // Stage 2: Symbol Preservation Audit
    const extractSymbols = (code) => {
        const symbols = new Set();
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

    const mergedSymbols = extractSymbols(mergedCode);
    const requiredSymbols = new Set([
        ...extractSymbols(agentAChange),
        ...extractSymbols(agentBChange)
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

    result.durationMs = Date.now() - startTime;
    return result;
}

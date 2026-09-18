import fs from 'fs';
import { execSync } from 'child_process';

export async function extractConflictChunk(basePath, agentAPath, agentBPath) {
    try {
        const output = execSync(`git merge-file -p "${agentAPath}" "${basePath}" "${agentBPath}"`);
        return output.toString();
    } catch (error) {
        if (error.stdout) {
            return error.stdout.toString();
        }
        throw error;
    }
}

export async function peacemakerMerge(filePath, agentAChange, agentBChange) {
    const prompt = `You are the Turfcode Peacemaker, an authoritative semantic code merger.
Your SOLE duty is to merge conflicting edits from Agent A and Agent B into a clean file.

INVARIANTS (VIOLATION IS A FATAL ERROR):
1. PRESERVE ALL FUNCTIONS: You must retain the exact functionality, variables, and logic introduced by BOTH Agent A and Agent B.
2. ZERO UNRELATED EDITS: Do not refactor, clean up, reformat, or rename existing code.
3. PRESERVE ERROR HANDLING: Never drop try/catch blocks, null checks, or async/await keywords.
4. OUTPUT FORMAT: Return ONLY the merged code block. No conversational markdown, no explanations, no preamble.

INPUT CONTEXT:
File: ${filePath}
<<<<<<< Agent A
${agentAChange}
=======
${agentBChange}
>>>>>>> Agent B

MERGED OUTPUT:`;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    if (!apiKey) {
        return fallbackMerge(agentAChange, agentBChange);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, 6000); // 6-Second Latency Guard

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: 'claude-3-5-sonnet-20241022',
                max_tokens: 4096,
                temperature: 0.0,
                messages: [
                    { role: 'user', content: prompt }
                ]
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);
        
        if (!response.ok) {
            return fallbackMerge(agentAChange, agentBChange);
        }

        const data = await response.json();
        let content = data.content[0].text;
        
        // Remove markdown blocks if present
        if (content.startsWith('\`\`\`')) {
            const lines = content.split('\\n');
            if (lines.length > 2) {
                content = lines.slice(1, -1).join('\\n');
            }
        }
        
        return content;
    } catch (e) {
        clearTimeout(timeout);
        return fallbackMerge(agentAChange, agentBChange);
    }
}

function fallbackMerge(agentAChange, agentBChange) {
    return `// Merged via Fallback Engine (Latency Guard)\n${agentAChange}\n${agentBChange}`;
}

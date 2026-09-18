import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const normalizeGitPath = (p) => p.replace(/\\/g, '/');

export function createWorktree(repoPath, roomCode, agentId, baseBranch = 'main') {
    const targetPath = path.join(os.tmpdir(), 'turf-worktrees', roomCode, agentId);
    
    // Ensure parent dir exists
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    
    // Check if worktree already exists
    if (!fs.existsSync(targetPath)) {
        const targetGitPath = normalizeGitPath(targetPath);
        try {
            execSync(`git worktree add -b turf/${agentId} "${targetGitPath}" ${baseBranch}`, { cwd: repoPath });
        } catch (e) {
            // If branch exists, just use it
            execSync(`git worktree add "${targetGitPath}" turf/${agentId}`, { cwd: repoPath });
        }
    }
    return targetPath;
}

export function removeWorktree(worktreePath) {
    if (fs.existsSync(worktreePath)) {
        const targetGitPath = normalizeGitPath(worktreePath);
        // Find main repo path by running git rev-parse inside the worktree
        let repoPath = targetGitPath;
        try {
           const gitDir = execSync(`git rev-parse --git-dir`, { cwd: targetGitPath }).toString().trim();
           // Workaround, we can just remove worktree using git worktree remove
           execSync(`git worktree remove -f "${targetGitPath}"`, { cwd: targetGitPath });
        } catch (e) {
            fs.rmSync(worktreePath, { recursive: true, force: true });
        }
    }
}

export function syncWorktree(worktreePath, filePath, content) {
    const fullPath = path.join(worktreePath, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
}

export function listWorktrees(repoPath) {
    const output = execSync(`git worktree list`, { cwd: repoPath }).toString();
    return output.split('\n').filter(line => line.trim() !== '');
}

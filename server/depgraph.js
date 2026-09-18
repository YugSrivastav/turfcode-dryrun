import fs from 'fs';
import path from 'path';

export class DepGraph {
    constructor(repoPath) {
        this.repoPath = repoPath;
        this.graph = new Map(); // file -> Set of files that depend on it
    }

    scan() {
        this.graph.clear();
        const walk = (dir) => {
            if (!fs.existsSync(dir)) return;
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                if (fs.statSync(fullPath).isDirectory()) {
                    if (!['node_modules', '.git', '.turf'].includes(file)) {
                        walk(fullPath);
                    }
                } else if (file.endsWith('.js') || file.endsWith('.ts') || file.endsWith('.jsx') || file.endsWith('.tsx')) {
                    this.parseFile(fullPath);
                }
            }
        };
        walk(this.repoPath);
    }

    parseFile(filePath) {
        const content = fs.readFileSync(filePath, 'utf8');
        // Match import ... from '...' or require('...')
        const importRegex = /(?:import\s+.*?from\s+['"]([^'"]+)['"])|(?:require\(['"]([^'"]+)['"]\))/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
            const imported = match[1] || match[2];
            if (imported.startsWith('.')) {
                // Resolve relative path
                const resolved = path.resolve(path.dirname(filePath), imported);
                // Try to find the exact file (it might lack extension)
                let ext = '';
                if (fs.existsSync(resolved)) {
                    ext = '';
                } else {
                    ext = ['.js', '.ts', '.jsx', '.tsx'].find(e => fs.existsSync(resolved + e)) || '';
                }
                const finalPath = path.relative(this.repoPath, resolved + ext).replace(/\\/g, '/');
                const relFilePath = path.relative(this.repoPath, filePath).replace(/\\/g, '/');
                
                if (!this.graph.has(finalPath)) {
                    this.graph.set(finalPath, new Set());
                }
                this.graph.get(finalPath).add(relFilePath);
            }
        }
    }

    getDependents(changedFile) {
        const normalized = changedFile.replace(/\\/g, '/');
        return Array.from(this.graph.get(normalized) || []);
    }
}

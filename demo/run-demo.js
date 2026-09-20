import fs from 'fs';
import path from 'path';
import { extractConflictChunk, peacemakerMerge } from '../server/peacemaker.js';
import { verifyCode } from '../server/verify.js';
import { createWorktree, removeWorktree, syncWorktree } from '../server/worktrees.js';
import { execSync } from 'child_process';
import os from 'os';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runDemo() {
    console.log("=== TURFCODE 2-MINUTE REHEARSAL DEMO ===");
    const repoPath = path.resolve('.');
    const roomCode = 'TRF-DEMO';
    
    // Setup git repo for demo if not exists
    if (!fs.existsSync('.git')) {
        execSync('git init');
    }
    try {
        execSync('git add demo/checkout.js');
        execSync('git commit -m "Initial commit"');
    } catch(e) {}

    console.log("\n[Act 1: The Parallel Sprint (0:00 – 0:30)]");
    console.log("Yug (Agent A) prompts: 'Add a 15% VIP discount logic to checkout.js'");
    const agentAWorktree = createWorktree(repoPath, roomCode, 'AgentA');
    
    // Agent A makes changes
    const checkoutAPath = path.join(agentAWorktree, 'demo/checkout.js');
    let contentA = fs.readFileSync(checkoutAPath, 'utf8');
    contentA = contentA.replace('let total = subtotal + tax + shipping;', 
`    let total = subtotal + tax + shipping;

    function applyVipDiscount() {
        if (user && user.tier === 'VIP') {
            total *= 0.85;
        }
    }
    applyVipDiscount();`);
    syncWorktree(agentAWorktree, 'demo/checkout.js', contentA);
    try {
        execSync('git add demo/checkout.js && git commit -m "Add VIP discount"', { cwd: agentAWorktree });
    } catch(e) {}
    console.log("-> Agent A finished and committed to speculative worktree turf/AgentA");

    console.log("\n[Act 2: The Collision (0:30 – 0:50)]");
    console.log("Ayush (Agent B) prompts: 'Add a $5 flat gift-wrap fee to checkout.js'");
    const agentBWorktree = createWorktree(repoPath, roomCode, 'AgentB');
    
    // Agent B makes changes
    const checkoutBPath = path.join(agentBWorktree, 'demo/checkout.js');
    let contentB = fs.readFileSync(checkoutBPath, 'utf8');
    contentB = contentB.replace('let total = subtotal + tax + shipping;', 
`    let total = subtotal + tax + shipping;

    function applyGiftWrap() {
        if (options && options.giftWrap) {
            total += 5.00;
        }
    }
    applyGiftWrap();`);
    syncWorktree(agentBWorktree, 'demo/checkout.js', contentB);
    try {
        execSync('git add demo/checkout.js && git commit -m "Add gift wrap fee"', { cwd: agentBWorktree });
    } catch(e) {}
    console.log("-> ⚠️ COLLISION DETECTED on checkout.js. Forked Ayush to speculative worktree turf/AgentB");

    console.log("\n[Act 3: The Peacemaker Miracle (0:50 – 1:20)]");
    console.log("-> Extracting 3-way conflict chunk...");
    
    // Just to simulate extraction
    let baseContent = '';
    try {
        baseContent = execSync('git show HEAD:demo/checkout.js', { cwd: repoPath }).toString();
    } catch(e) {
        baseContent = fs.readFileSync('demo/checkout.js', 'utf8');
    }
    
    const tempBase = path.join(os.tmpdir(), 'base.js');
    fs.writeFileSync(tempBase, baseContent);
    
    let conflictChunk = null;
    try {
        conflictChunk = await extractConflictChunk(tempBase, checkoutAPath, checkoutBPath);
    } catch(e) {
        conflictChunk = e.message;
    }
    console.log(conflictChunk ? "-> Git merge-file generated conflict." : "-> No conflict (unexpected!).");

    console.log("-> Peacemaker Engaged: Merging VIP Discount + Gift-Wrap Fee via Claude 3.5 Sonnet");
    const mergedContent = await peacemakerMerge('demo/checkout.js', baseContent, contentA, contentB);
    
    console.log("-> Running 3-Stage Verification...");
    const verifyResult = verifyCode(mergedContent, contentA, contentB);
    
    if (verifyResult.valid) {
        console.log(`[✓] Syntax Check Passed (node --check OK) - ${verifyResult.durationMs}ms`);
        console.log(`[✓] Symbol Audit Passed`);
        if (verifyResult.astAudit && verifyResult.astAudit.passed) {
            console.log(`[✓] Babel AST Semantic Audit Passed (${verifyResult.astAudit.exports.length} export(s) preserved: ${verifyResult.astAudit.exports.join(', ')})`);
        }
        
        console.log("\n[Act 4: The Punchline (1:20 – 1:40)]");
        console.log("Final Merged output synced successfully.");
        console.log("-----------------------------------------");
        console.log(mergedContent);
        console.log("-----------------------------------------");
    } else {
        console.error("Verification failed:", verifyResult.errors);
    }
    
    // Cleanup
    try {
        removeWorktree(agentAWorktree, repoPath);
        removeWorktree(agentBWorktree, repoPath);
    } catch(e) {}
}

runDemo();

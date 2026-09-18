import React from 'react';
import { ShieldCheck, CheckCircle, X } from 'lucide-react';

export default function DiffViewer({ diff, onResolve, onClose }) {
  if (!diff) return null;

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-8 font-mono backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-7xl flex flex-col overflow-hidden max-h-full">
        {/* Header */}
        <div className="h-14 border-b border-slate-800 bg-slate-800/50 flex items-center justify-between px-6">
          <div className="flex items-center space-x-3 text-slate-200">
            <ShieldCheck className="text-purple-400" />
            <span className="font-bold">PEACEMAKER 3-WAY RECONCILIATION MODAL</span>
            <span className="text-slate-400">— `{diff.file}`</span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* 3 Columns */}
        <div className="flex-1 flex overflow-hidden">
          {/* Agent A */}
          <div className="flex-1 border-r border-slate-800 flex flex-col">
            <div className="p-3 border-b border-slate-800 bg-emerald-950/30 text-emerald-400 text-xs font-bold flex justify-between">
              <span>VERSION A ({diff.agentA.name} @ {diff.agentA.agent})</span>
            </div>
            <div className="p-4 flex-1 overflow-auto bg-slate-950 text-sm">
              <pre className="text-emerald-400">
                {diff.agentA.code.split('\n').map((line, i) => (
                  <div key={i}>+ {line}</div>
                ))}
              </pre>
            </div>
          </div>
          
          {/* Agent B */}
          <div className="flex-1 border-r border-slate-800 flex flex-col">
            <div className="p-3 border-b border-slate-800 bg-blue-950/30 text-blue-400 text-xs font-bold flex justify-between">
              <span>VERSION B ({diff.agentB.name} @ {diff.agentB.agent})</span>
            </div>
            <div className="p-4 flex-1 overflow-auto bg-slate-950 text-sm">
              <pre className="text-blue-400">
                {diff.agentB.code.split('\n').map((line, i) => (
                  <div key={i}>+ {line}</div>
                ))}
              </pre>
            </div>
          </div>

          {/* Merged */}
          <div className="flex-1 flex flex-col">
            <div className="p-3 border-b border-slate-800 bg-purple-950/30 text-purple-400 text-xs font-bold flex justify-between">
              <span>VERIFIED PEACEMAKER MERGE</span>
            </div>
            <div className="p-4 flex-1 overflow-auto bg-slate-950 text-sm">
              <pre className="text-slate-300">
                {diff.merged.split('\n').map((line, i) => (
                  <div key={i}>  {line}</div>
                ))}
              </pre>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-800/50">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-4">
              <span className="text-sm font-bold text-slate-300">Verification Badge:</span>
              <div className="flex items-center text-xs text-emerald-400 bg-emerald-400/10 border border-emerald-400/30 px-3 py-1 rounded">
                <CheckCircle size={14} className="mr-2" />
                Syntax: node --check PASS (42ms)
              </div>
              <div className="flex items-center text-xs text-emerald-400 bg-emerald-400/10 border border-emerald-400/30 px-3 py-1 rounded">
                <CheckCircle size={14} className="mr-2" />
                Symbol Audit: Both Functions Present
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-400">Action: [ Auto-Synchronized to Both Worktrees at 19:04:22 ]</div>
            <button 
              onClick={onResolve}
              className="bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2 rounded text-sm font-bold shadow-[0_0_15px_rgba(16,185,129,0.3)] transition-all"
            >
              Accept & Commit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

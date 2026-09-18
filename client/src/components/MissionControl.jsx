import React from 'react';
import { Activity, ShieldCheck, FileCode2, Clock, CheckCircle2 } from 'lucide-react';

export default function MissionControl({ onBack, feedEvents, activeLocks, queue }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-mono flex flex-col">
      {/* Header */}
      <div className="h-14 border-b border-slate-800 bg-slate-900 flex items-center justify-between px-6 shadow-md">
        <div className="flex items-center space-x-4">
          <Activity className="text-emerald-400" />
          <span className="font-bold text-lg text-slate-100">[Turfcode Mission Control]</span>
          <span className="text-slate-400 border-l border-slate-700 pl-4">Room: <span className="text-slate-200">TRF-4829</span></span>
          <span className="text-slate-400 border-l border-slate-700 pl-4 flex items-center"><Clock size={16} className="mr-2"/> Sprint Elapsed: 01:24:10</span>
        </div>
        <button onClick={onBack} className="text-slate-400 hover:text-slate-200 transition-colors flex items-center text-sm font-medium border border-slate-700 px-4 py-1.5 rounded bg-slate-800">
          [ Back to Cockpit ]
        </button>
      </div>

      <div className="flex-1 flex p-6 space-x-6 overflow-hidden">
        {/* Left Column - Heatmap */}
        <div className="w-1/3 flex flex-col space-y-6">
          <div className="flex-1 border border-slate-800 rounded bg-slate-900/50 flex flex-col">
            <div className="p-4 border-b border-slate-800 font-bold text-sm text-slate-400">GLOBAL REPOSITORY INTENT HEATMAP</div>
            <div className="p-4 flex-1 overflow-auto text-sm space-y-2">
              <div className="text-slate-300 font-bold">demo-repo/</div>
              <div className="pl-4 border-l border-slate-700 ml-2 space-y-2">
                <div className="text-slate-300 font-bold">src/</div>
                <div className="pl-4 border-l border-slate-700 ml-2 space-y-2">
                  <div className="flex justify-between items-center text-slate-400">
                    <span className="flex items-center"><FileCode2 size={14} className="mr-2"/> auth.ts</span>
                    <span className="text-emerald-500 text-xs px-2 py-0.5 bg-emerald-500/10 rounded">[Idle - Green]</span>
                  </div>
                  <div className="flex flex-col space-y-1">
                    <div className="flex justify-between items-center text-slate-200">
                      <span className="flex items-center"><FileCode2 size={14} className="mr-2 text-amber-400"/> checkout.js</span>
                      <span className="text-amber-400 text-xs px-2 py-0.5 bg-amber-400/10 border border-amber-400/30 rounded shadow-[0_0_10px_rgba(251,191,36,0.2)]">[🔥 LOCKED - Yug]</span>
                    </div>
                    <div className="pl-6 text-xs text-slate-500">└── ⚠️ 1 queued: Ayush (Claude)</div>
                  </div>
                  <div className="flex justify-between items-center text-slate-200">
                    <span className="flex items-center"><FileCode2 size={14} className="mr-2 text-amber-400"/> models.py</span>
                    <span className="text-amber-400 text-xs px-2 py-0.5 bg-amber-400/10 border border-amber-400/30 rounded shadow-[0_0_10px_rgba(251,191,36,0.2)]">[🔥 LOCKED - Ayush]</span>
                  </div>
                  <div className="flex justify-between items-center text-slate-400">
                    <span className="flex items-center"><FileCode2 size={14} className="mr-2"/> utils.ts</span>
                    <span className="text-emerald-500 text-xs px-2 py-0.5 bg-emerald-500/10 rounded">[Idle - Green]</span>
                  </div>
                </div>
                <div className="flex justify-between items-center text-slate-400 mt-2">
                  <span className="flex items-center"><FileCode2 size={14} className="mr-2"/> package.json</span>
                  <span className="text-emerald-500 text-xs px-2 py-0.5 bg-emerald-500/10 rounded">[Idle - Green]</span>
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-slate-800 text-xs flex justify-between text-slate-400 bg-slate-900">
              <span>Active Turfs: 2/6 files</span>
              <span>Team Concurrency: 100%</span>
            </div>
          </div>
        </div>

        {/* Right Column - Feed & Status */}
        <div className="w-2/3 flex flex-col space-y-6">
          <div className="flex-2 border border-slate-800 rounded bg-slate-900/50 flex flex-col h-2/3">
            <div className="p-4 border-b border-slate-800 font-bold text-sm text-slate-400">REAL-TIME TEAM INTENT & PROMPT FEED</div>
            <div className="p-4 flex-1 overflow-auto space-y-6 scrollbar-thin">
              {feedEvents.map(event => (
                <div key={event.id} className="relative pl-4 border-l-2 border-slate-700">
                  <div className="text-xs text-slate-500 mb-1">[{event.time}] <span className="text-slate-300 font-bold">{event.user}</span> ({event.agent}):</div>
                  <div className="bg-slate-800/80 p-3 rounded border border-slate-700 text-sm mb-2 text-slate-300 shadow-sm">
                    💬 Prompt: "{event.prompt}"
                  </div>
                  <div className="text-xs space-y-1">
                    <div className="text-slate-400">🎯 Target: <span className="text-emerald-400">{event.target}</span></div>
                    {event.ttl && (
                      <div className="flex items-center space-x-2 text-slate-400">
                        <span>⏱️ Lease: 15s TTL</span>
                        <div className="w-32 h-1.5 bg-slate-800 rounded-full overflow-hidden flex">
                          <div className="h-full bg-amber-400" style={{ width: `${(event.ttl/15)*100}%`}}></div>
                        </div>
                        <span className="text-amber-400">{event.ttl}s left</span>
                      </div>
                    )}
                    {event.collision && (
                      <div className="text-amber-400 mt-2 bg-amber-400/10 border border-amber-400/30 p-2 rounded">
                        <div>⚠️ COLLISION: {event.collision.split('.')[0]}.</div>
                        <div>🔀 Status: {event.collision.split('.')[1]}.</div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          <div className="flex space-x-6 h-1/3">
            <div className="flex-1 border border-slate-800 rounded bg-slate-900/50 flex flex-col">
              <div className="p-4 border-b border-slate-800 font-bold text-sm text-slate-400">AI PEACEMAKER ACTIVE RECONCILIATIONS</div>
              <div className="p-4">
                <div className="flex items-start space-x-3 bg-slate-800/50 p-3 rounded border border-slate-700">
                  <ShieldCheck className="text-purple-400 mt-0.5" size={18} />
                  <div>
                    <div className="text-sm font-bold text-slate-200">checkout.js: Merging Yug (VIP) + Ayush (Wrap)</div>
                    <div className="text-xs text-slate-400 mt-1 animate-pulse">Status: Synthesizing 3-way AST diff...</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex-1 border border-slate-800 rounded bg-slate-900/50 flex flex-col">
              <div className="p-4 border-b border-slate-800 font-bold text-sm text-slate-400">SYSTEM PERFORMANCE & HEALTH</div>
              <div className="p-4 grid grid-cols-2 gap-4">
                <div className="bg-slate-800/50 p-3 rounded border border-slate-700">
                  <div className="text-xs text-slate-500 mb-1">WebSocket Latency</div>
                  <div className="text-lg text-emerald-400 font-bold">4ms</div>
                </div>
                <div className="bg-slate-800/50 p-3 rounded border border-slate-700">
                  <div className="text-xs text-slate-500 mb-1">Lock Table</div>
                  <div className="text-lg text-slate-200 font-bold">2 active</div>
                </div>
                <div className="col-span-2 bg-slate-800/50 p-3 rounded border border-slate-700 flex items-center justify-between">
                  <div className="text-sm text-slate-300">Peacemaker Success Rate</div>
                  <div className="flex items-center text-emerald-400 text-sm font-bold">
                    <CheckCircle2 size={16} className="mr-1"/> 100% (4/4 merges)
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

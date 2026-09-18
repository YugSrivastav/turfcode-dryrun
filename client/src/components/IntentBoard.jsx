import React from 'react';
import { Lock } from 'lucide-react';

export default function IntentBoard({ locks }) {
  return (
    <div className="flex-1 p-4 bg-slate-900/50">
      <div className="flex items-center space-x-2 text-slate-400 mb-4 font-bold text-sm">
        <Lock size={16} />
        <span>INTENT & ALERTS</span>
      </div>
      <div className="space-y-4">
        <div>
          <div className="text-xs text-slate-500 mb-2">ACTIVE TURFS:</div>
          <div className="space-y-2">
            {locks.map((lock, i) => (
              <div key={i} className="text-sm">
                <div className="flex items-center space-x-2">
                  <span className="text-amber-400">{'->'}</span>
                  <span className="text-slate-300 truncate">{lock.file}</span>
                </div>
                <div className="pl-5 text-xs text-slate-400 mt-1 flex items-center justify-between">
                  <span>[{lock.user} @ {lock.agent}]</span>
                  <span className="text-amber-400">{lock.ttl}s</span>
                </div>
                <div className="ml-5 mt-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full bg-amber-400 transition-all duration-1000" style={{ width: `${(lock.ttl / 15) * 100}%` }}></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

import React from 'react';
import { ListTree } from 'lucide-react';

export default function QueuePanel({ queue }) {
  return (
    <div className="h-48 border-b border-slate-800 p-4">
      <div className="flex items-center space-x-2 text-slate-400 mb-4 font-bold text-sm">
        <ListTree size={16} />
        <span>FILE QUEUE</span>
      </div>
      <div className="space-y-3">
        {queue.length === 0 ? (
          <div className="text-sm text-slate-500">Queue is empty</div>
        ) : (
          queue.map(q => (
            <div key={q.id} className="p-3 bg-slate-800/50 rounded border border-slate-700">
              <div className="text-sm text-slate-300 mb-1">{q.file}</div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">{q.user} @ {q.agent}</span>
                <span className="px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded border border-amber-500/30">{q.priority}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

import React from 'react';
import { Users } from 'lucide-react';

export default function ActivityBar({ peers }) {
  return (
    <div className="flex-1 p-4 border-b border-slate-800">
      <div className="flex items-center space-x-2 text-slate-400 mb-4 font-bold text-sm">
        <Users size={16} />
        <span>PEOPLE & ACTIVITY</span>
      </div>
      <div className="space-y-3">
        {peers.map(peer => (
          <div key={peer.id} className="flex items-center justify-between text-sm">
            <div className="flex items-center space-x-2">
              <div className={`w-2 h-2 rounded-full ${peer.status === 'active' ? 'bg-emerald-500' : 'bg-slate-500'}`}></div>
              <span className={peer.status === 'active' ? 'text-slate-200' : 'text-slate-400'}>{peer.name}</span>
            </div>
            {peer.activeAgent ? (
              <span className="text-xs px-2 py-0.5 bg-slate-800 text-slate-300 rounded border border-slate-700">1 act</span>
            ) : (
              <span className="text-xs text-slate-500">[idle]</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

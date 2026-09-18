import React from 'react';
import { AlertTriangle, ChevronRight } from 'lucide-react';

export default function AlertToast({ alert, onAction }) {
  return (
    <div className="w-80 bg-slate-900 border border-amber-500/50 rounded shadow-[0_4px_20px_rgba(245,158,11,0.15)] overflow-hidden">
      <div className="flex p-3">
        <AlertTriangle className="text-amber-500 shrink-0 mt-0.5" size={18} />
        <div className="ml-3">
          <div className="text-xs text-slate-400 mb-1">LIVE ALERT [{alert.time}]</div>
          <div className="text-sm text-slate-200">{alert.text}</div>
          {alert.action === 'diff' && (
            <button 
              onClick={() => onAction('diff')}
              className="mt-2 text-xs text-amber-400 hover:text-amber-300 flex items-center font-bold"
            >
              View Peacemaker Resolution <ChevronRight size={14} className="ml-1"/>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

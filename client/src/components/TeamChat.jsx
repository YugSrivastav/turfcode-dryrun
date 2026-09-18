import React, { useState } from 'react';
import { MessageSquare } from 'lucide-react';

export default function TeamChat({ messages, onSendMessage }) {
  const [msg, setMsg] = useState('');

  const send = () => {
    if(msg.trim()) {
      onSendMessage(msg);
      setMsg('');
    }
  };

  return (
    <div className="flex-1 flex flex-col p-4 bg-slate-900/30">
      <div className="flex items-center space-x-2 text-slate-400 mb-4 font-bold text-sm">
        <MessageSquare size={16} />
        <span>TEAM CHAT</span>
      </div>
      <div className="flex-1 overflow-y-auto space-y-3 scrollbar-thin mb-4">
        {messages.map(m => (
          <div key={m.id} className="text-sm">
            <span className="text-emerald-400">[{m.user}]: </span>
            <span className="text-slate-300">{m.message}</span>
          </div>
        ))}
      </div>
      <div className="relative">
        <span className="absolute left-2 top-1.5 text-slate-500">{'>'}</span>
        <input 
          type="text" 
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          className="w-full bg-slate-800 border border-slate-700 rounded py-1.5 pl-6 pr-8 text-slate-200 outline-none focus:border-slate-500 text-sm"
          placeholder="Type message..."
        />
      </div>
    </div>
  );
}

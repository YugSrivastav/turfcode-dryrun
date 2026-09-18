import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

export default function TerminalPane() {
  const terminalRef = useRef(null);
  const [activeAgent, setActiveAgent] = useState('Antigravity (agy)');
  const [inputVal, setInputVal] = useState('');

  useEffect(() => {
    if (!terminalRef.current) return;
    const term = new Terminal({
      theme: {
        background: '#020617', // slate-950
        foreground: '#e2e8f0', // slate-200
        cursor: '#34d399', // emerald-400
      },
      fontFamily: '"Fira Code", monospace',
      fontSize: 14,
      cursorBlink: true,
    });
    term.open(terminalRef.current);
    term.writeln('\x1b[32magy>\x1b[0m Initialized workspace in /demo-repo');
    term.writeln('\x1b[32magy>\x1b[0m Inspecting checkout.js...');
    term.writeln('\x1b[32magy>\x1b[0m Planning tool: \x1b[36mreplace_file_content\x1b[0m');
    term.writeln('\x1b[33magy> [Turf Lock Granted: checkout.js (15s TTL)]\x1b[0m');
    term.writeln('\x1b[32magy>\x1b[0m Writing VIP 15% discount logic...');
    term.writeln('\x1b[32magy>\x1b[0m Replace complete. Lines 40-75 updated.');
    term.writeln('\x1b[32magy>\x1b[0m Running syntax check... OK.');
    
    return () => term.dispose();
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 border-b border-slate-800 flex items-center justify-between px-4 bg-slate-900/30">
        <div className="flex items-center space-x-3 text-sm">
          <span className="text-slate-400">Active CLI:</span>
          <select 
            value={activeAgent} 
            onChange={(e) => setActiveAgent(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-2 py-1 outline-none"
          >
            <option value="Antigravity (agy)">Antigravity (agy)</option>
            <option value="Claude (claude)">Claude (claude)</option>
            <option value="Codex (codex)">Codex (codex)</option>
            <option value="Shell (bash)">Shell (bash)</option>
          </select>
        </div>
        <button className="text-xs px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition-colors">Restart</button>
      </div>
      <div className="flex-1 p-4 overflow-hidden" ref={terminalRef}></div>
      <div className="h-12 border-t border-slate-800 flex items-center px-4 bg-slate-900/30">
        <span className="text-emerald-400 mr-2">{'>'}</span>
        <input 
          type="text" 
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={(e) => {
            if(e.key === 'Enter') {
              setInputVal('');
            }
          }}
          className="flex-1 bg-transparent border-none outline-none text-slate-200 placeholder-slate-600 text-sm"
          placeholder="Input terminal command or prompt..."
        />
        <span className="text-slate-500 text-xs ml-2">[Enter]</span>
      </div>
    </div>
  );
}

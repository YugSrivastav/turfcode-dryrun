import React, { useState } from 'react';
import { Terminal } from 'lucide-react';

export default function OnboardingScreen({ onJoin }) {
  const [step, setStep] = useState('menu');
  const [name, setName] = useState('');
  const [room, setRoom] = useState('');
  
  const handleHost = () => {
    onJoin(name || 'Host', 'TRF-4829');
  };

  const handleJoin = () => {
    onJoin(name || 'Peer', room || 'TRF-4829');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-mono p-8 flex flex-col">
      <div className="max-w-3xl mx-auto w-full mt-10">
        <div className="border border-emerald-500/50 rounded p-6 bg-slate-900/50 mb-8 shadow-[0_0_15px_rgba(16,185,129,0.15)]">
          <div className="flex items-center space-x-3 mb-2 text-emerald-400">
            <Terminal size={24} />
            <h1 className="text-2xl font-bold tracking-wider">TURFCODE CLI v1.0</h1>
          </div>
          <p className="text-slate-400">Real-Time Multi-Agent Collaboration Engine for Teams</p>
        </div>

        <div className="space-y-6">
          {step === 'menu' && (
            <div className="space-y-4 text-lg">
              <button onClick={() => setStep('host')} className="w-full text-left p-4 hover:bg-slate-800 rounded border border-slate-700 transition-colors">
                <span className="text-amber-400">[1]</span> Create Turf <span className="text-slate-500 text-sm ml-2">(Host a new session for your team)</span>
              </button>
              <button onClick={() => setStep('join')} className="w-full text-left p-4 hover:bg-slate-800 rounded border border-slate-700 transition-colors">
                <span className="text-amber-400">[2]</span> Join Turf <span className="text-slate-500 text-sm ml-2">(Connect to an existing room code)</span>
              </button>
            </div>
          )}

          {step === 'host' && (
            <div className="space-y-4">
              <div>
                <label className="block text-slate-400 mb-2">{'>'} Enter your name:</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded p-3 text-slate-200 outline-none focus:border-emerald-500" placeholder="Yug" autoFocus />
              </div>
              <button onClick={handleHost} className="mt-4 px-6 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-medium transition-colors">Start Daemon</button>
            </div>
          )}

          {step === 'join' && (
            <div className="space-y-4">
              <div>
                <label className="block text-slate-400 mb-2">{'>'} Enter your name:</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded p-3 text-slate-200 outline-none focus:border-emerald-500 mb-4" placeholder="Ayush" autoFocus />
              </div>
              <div>
                <label className="block text-slate-400 mb-2">{'>'} Enter Turf Room Code:</label>
                <input type="text" value={room} onChange={e => setRoom(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded p-3 text-slate-200 outline-none focus:border-emerald-500" placeholder="TRF-4829" />
              </div>
              <button onClick={handleJoin} className="mt-4 px-6 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-medium transition-colors">Connect</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

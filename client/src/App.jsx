import React, { useState, useEffect } from 'react';
import OnboardingScreen from './components/OnboardingScreen';
import ActivityBar from './components/ActivityBar';
import IntentBoard from './components/IntentBoard';
import TerminalPane from './components/TerminalPane';
import QueuePanel from './components/QueuePanel';
import TeamChat from './components/TeamChat';
import MissionControl from './components/MissionControl';
import DiffViewer from './components/DiffViewer';
import AlertToast from './components/AlertToast';

function App() {
  const [activeScreen, setActiveScreen] = useState('cockpit');
  const [currentUser, setCurrentUser] = useState('Yug');
  const [activeRoom, setActiveRoom] = useState('TRF-4829');
  const [connectedPeers, setConnectedPeers] = useState([]);
  const [activeLocks, setActiveLocks] = useState([]);
  const [queue, setQueue] = useState([]);
  const [feedEvents, setFeedEvents] = useState([]);
  const [teamChat, setTeamChat] = useState([]);
  const [diffModalState, setDiffModalState] = useState(null);
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    const userParam = params.get('user');
    if (roomParam) {
      setActiveRoom(roomParam);
      setCurrentUser(userParam || 'Yug');
      setActiveScreen('cockpit');
    }

    // Mock initial data for UI
    setConnectedPeers([
      { id: 1, name: 'Yug', activeAgent: 'agy', status: 'active' },
      { id: 2, name: 'Ayush', activeAgent: 'claude', status: 'active' },
      { id: 3, name: 'Krishna', activeAgent: null, status: 'idle' },
      { id: 4, name: 'Nakshatra', activeAgent: null, status: 'idle' }
    ]);
    setActiveLocks([
      { file: 'src/checkout.js', user: 'Yug', agent: 'agy', ttl: 11 },
      { file: 'src/models.py', user: 'Ayush', agent: 'claude', ttl: 8 }
    ]);
    setQueue([
      { id: 1, agent: 'claude', user: 'Ayush', file: 'src/checkout.js', priority: 'Tier 1' }
    ]);
    setTeamChat([
      { id: 1, user: 'Ayush', message: 'checkout almost ready?' },
      { id: 2, user: 'Yug', message: 'landing my 15% discount now' }
    ]);
    setFeedEvents([
      { id: 1, time: '19:04:02', user: 'Yug Srivastav', agent: 'Antigravity', prompt: 'Add 15% VIP discount logic to checkout.js based on customer tier', target: 'src/checkout.js (lines 40-75)', ttl: 11 },
      { id: 2, time: '19:04:17', user: 'Ayush Singh', agent: 'Claude Code', prompt: 'Add $5 flat gift-wrap fee to checkout.js', target: 'src/checkout.js', collision: 'File locked by Yug. Forked to .turf/worktrees/agent-b' }
    ]);
  }, []);

  const handleJoinRoom = (name, room) => {
    setCurrentUser(name);
    setActiveRoom(room);
    setActiveScreen('cockpit');
  };

  const handleAlertAction = (action) => {
    if (action === 'diff') {
      setDiffModalState({
        file: 'src/checkout.js',
        agentA: { name: 'Yug Srivastav', agent: 'agy', code: 'function applyVipDiscount() {\n  if (user.isVip) {\n    total *= 0.85;\n  }\n}' },
        agentB: { name: 'Ayush Singh', agent: 'claude', code: 'function applyGiftWrap() {\n  if (cart.giftWrap) {\n    total += 5.00;\n  }\n}' },
        merged: 'function calculateTotal() {\n  applyVipDiscount();\n  applyGiftWrap();\n  return total;\n}'
      });
    }
  };

  if (activeScreen === 'onboarding') return <OnboardingScreen onJoin={handleJoinRoom} />;
  if (activeScreen === 'dashboard') return <MissionControl onBack={() => setActiveScreen('cockpit')} feedEvents={feedEvents} activeLocks={activeLocks} queue={queue} />;

  return (
    <div className="flex h-screen bg-slate-950 text-slate-200 overflow-hidden font-mono">
      {/* Top Nav */}
      <div className="absolute top-0 w-full h-10 border-b border-slate-800 bg-slate-900 flex items-center justify-between px-4 z-10 shadow-md">
        <div className="flex items-center space-x-4">
          <span className="font-bold text-emerald-400">[Turfcode]</span>
          <span className="text-slate-400">Room: <span className="text-slate-200">{activeRoom}</span></span>
          <span className="text-slate-400">User: <span className="text-slate-200">{currentUser} (Host)</span></span>
        </div>
        <button onClick={() => setActiveScreen('dashboard')} className="text-amber-400 hover:text-amber-300 transition-colors flex items-center text-sm font-medium border border-amber-400/30 px-3 py-1 rounded bg-amber-400/10">
          Live Mission Control ↗
        </button>
      </div>

      <div className="flex flex-1 mt-10 h-[calc(100vh-40px)]">
        {/* Left Panel */}
        <div className="w-64 border-r border-slate-800 bg-slate-900 flex flex-col">
          <ActivityBar peers={connectedPeers} />
          <IntentBoard locks={activeLocks} />
        </div>
        {/* Center */}
        <div className="flex-1 bg-slate-950 relative border-r border-slate-800 flex flex-col">
          <TerminalPane />
        </div>
        {/* Right */}
        <div className="w-80 bg-slate-900 flex flex-col">
          <QueuePanel queue={queue} />
          <TeamChat messages={teamChat} onSendMessage={(msg) => setTeamChat([...teamChat, { id: Date.now(), user: currentUser, message: msg }])} />
        </div>
      </div>

      {/* Floating Elements */}
      <div className="absolute bottom-4 left-4 z-50 flex flex-col space-y-2">
        <AlertToast alert={{ id: 'mock', time: '19:04:12', text: '⚠️ Ayush collided on checkout.js. Forked to worktree. Peacemaker staged.', action: 'diff' }} onAction={handleAlertAction} />
      </div>

      {diffModalState && <DiffViewer diff={diffModalState} onResolve={() => setDiffModalState(null)} onClose={() => setDiffModalState(null)} />}
    </div>
  );
}

export default App;

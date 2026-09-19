import React, { useState, useEffect, useRef } from 'react';
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
  const [currentUser, setCurrentUser] = useState('User');
  const [activeRoom, setActiveRoom] = useState('TRF-XXXX');
  const [connectedPeers, setConnectedPeers] = useState([]);
  const [activeLocks, setActiveLocks] = useState([]);
  const [queue, setQueue] = useState([]);
  const [feedEvents, setFeedEvents] = useState([]);
  const [teamChat, setTeamChat] = useState([]);
  const [diffModalState, setDiffModalState] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [wsPort, setWsPort] = useState(7873);

  const wsRef = useRef(null);

  // Initialize room & connection from query params or defaults
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    const userParam = params.get('user');
    const portParam = parseInt(params.get('port') || window.location.port || '7873', 10);

    setWsPort(portParam);
    if (roomParam) setActiveRoom(roomParam);
    if (userParam) setCurrentUser(userParam);

    let isMounted = true;
    let reconnectTimer = null;

    function connectWs() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.hostname || '127.0.0.1';
      const wsUrl = `${protocol}//${host}:${portParam}`;

      try {
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!isMounted) return;
          setIsConnected(true);
          ws.send(JSON.stringify({
            type: 'peer:join',
            user: userParam || 'User',
            role: 'Spectator',
            room: roomParam || 'TRF-XXXX'
          }));

          // Fetch initial state via HTTP
          fetch(`http://${host}:${portParam}/api/room`)
            .then(res => res.json())
            .then(data => {
              if (data && data.peers) {
                setConnectedPeers(data.peers.map((p, idx) => ({
                  id: idx + 1,
                  name: p.name || p.user || 'Unknown',
                  activeAgent: p.activeAgent || p.agent || null,
                  status: p.status || 'active'
                })));
              }
            }).catch(() => {});

          fetch(`http://${host}:${portParam}/api/locks`)
            .then(res => res.json())
            .then(locks => {
              if (Array.isArray(locks)) {
                setActiveLocks(locks.map(l => ({
                  file: l.filePath || l.file,
                  user: l.user || 'Unknown',
                  agent: l.agentId || l.agent || 'turf',
                  ttl: Math.max(1, Math.round(((l.expiresAt || Date.now() + 15000) - Date.now()) / 1000))
                })));
              }
            }).catch(() => {});
        };

        ws.onmessage = (event) => {
          if (!isMounted) return;
          try {
            const data = JSON.parse(event.data);

            if (data.type === 'peer:update' && Array.isArray(data.peers)) {
              setConnectedPeers(data.peers.map((p, idx) => ({
                id: idx + 1,
                name: p.name || p.user || 'Unknown',
                activeAgent: p.activeAgent || p.agent || null,
                status: p.status || 'active'
              })));
            } else if (data.type === 'chat:message' || data.type === 'chat:send') {
              setTeamChat(prev => [...prev, {
                id: Date.now() + Math.random(),
                user: data.user || 'Team',
                message: data.message || ''
              }]);
            } else if (data.type === 'lock:granted') {
              setActiveLocks(prev => {
                const filtered = prev.filter(l => l.file !== data.filePath);
                return [...filtered, {
                  file: data.filePath,
                  user: data.user,
                  agent: data.agentId || 'turf',
                  ttl: Math.round((data.expiresInMs || 15000) / 1000)
                }];
              });
              setFeedEvents(prev => [{
                id: Date.now(),
                time: new Date().toLocaleTimeString(),
                user: data.user,
                agent: data.agentId || 'turf',
                prompt: `Lock acquired on ${data.filePath}`,
                target: data.filePath,
                ttl: Math.round((data.expiresInMs || 15000) / 1000)
              }, ...prev.slice(0, 40)]);
            } else if (data.type === 'lock:released') {
              setActiveLocks(prev => prev.filter(l => l.file !== data.filePath));
            } else if (data.type === 'lock:conflict') {
              setQueue(prev => [...prev, {
                id: Date.now(),
                file: data.filePath,
                user: data.user,
                agent: data.agentId || 'turf',
                priority: `Tier ${data.priorityTier || 1}`
              }]);
              setAlerts(prev => [{
                id: Date.now(),
                time: new Date().toLocaleTimeString(),
                text: `⚠️ ${data.user} collided on ${data.filePath}. Forked to speculative worktree.`,
                action: 'diff'
              }, ...prev.slice(0, 4)]);
            } else if (data.type === 'peacemaker:diff') {
              setDiffModalState({
                file: data.filePath,
                agentA: data.agentA,
                agentB: data.agentB,
                merged: data.merged
              });
            } else if (data.type === 'agent:msg') {
              setFeedEvents(prev => [{
                id: Date.now(),
                time: new Date().toLocaleTimeString(),
                user: data.tabId || 'agent',
                agent: data.tabId || 'agent',
                prompt: data.text ? data.text.replace(/\{[^}]+\}/g, '').slice(0, 100) : '',
                target: data.tabId
              }, ...prev.slice(0, 40)]);
            }
          } catch (e) {}
        };

        ws.onclose = () => {
          if (!isMounted) return;
          setIsConnected(false);
          reconnectTimer = setTimeout(connectWs, 3000);
        };

        ws.onerror = () => {
          if (!isMounted) return;
          setIsConnected(false);
        };
      } catch (e) {
        if (isMounted) reconnectTimer = setTimeout(connectWs, 3000);
      }
    }

    connectWs();

    // Decrement active lock TTL every second
    const ttlTimer = setInterval(() => {
      setActiveLocks(prev =>
        prev
          .map(l => ({ ...l, ttl: Math.max(0, l.ttl - 1) }))
          .filter(l => l.ttl > 0)
      );
    }, 1000);

    return () => {
      isMounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(ttlTimer);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const handleSendMessage = (msg) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'chat:send',
        user: currentUser,
        message: msg
      }));
    } else {
      // Optimistic local add if socket buffering
      setTeamChat(prev => [...prev, { id: Date.now(), user: currentUser, message: msg }]);
    }
  };

  const handleJoinRoom = (name, room) => {
    setCurrentUser(name);
    setActiveRoom(room);
    setActiveScreen('cockpit');
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'peer:join',
        user: name,
        role: 'Peer',
        room: room
      }));
    }
  };

  const handleAlertAction = (action) => {
    if (action === 'diff' && !diffModalState) {
      setDiffModalState({
        file: 'src/checkout.js',
        agentA: { name: 'Agent A', agent: 'turf', code: '// Agent A staged changes' },
        agentB: { name: 'Agent B', agent: 'cmdc', code: '// Agent B staged changes' },
        merged: '// Peacemaker verified merge output'
      });
    }
  };

  if (activeScreen === 'onboarding') return <OnboardingScreen onJoin={handleJoinRoom} />;
  if (activeScreen === 'dashboard') return (
    <MissionControl
      onBack={() => setActiveScreen('cockpit')}
      feedEvents={feedEvents}
      activeLocks={activeLocks}
      queue={queue}
    />
  );

  return (
    <div className="flex h-screen bg-slate-950 text-slate-200 overflow-hidden font-mono">
      {/* Top Nav */}
      <div className="absolute top-0 w-full h-10 border-b border-slate-800 bg-slate-900 flex items-center justify-between px-4 z-10 shadow-md">
        <div className="flex items-center space-x-4">
          <span className="font-bold text-emerald-400">[Turfcode]</span>
          <span className="text-slate-400">Room: <span className="text-slate-200">{activeRoom}</span></span>
          <span className="text-slate-400">User: <span className="text-slate-200">{currentUser}</span></span>
          {!isConnected && (
            <span className="px-2 py-0.5 text-xs bg-amber-950 text-amber-400 border border-amber-800 rounded animate-pulse">
              Connecting to daemon ({wsPort})...
            </span>
          )}
          {isConnected && (
            <span className="px-2 py-0.5 text-xs bg-emerald-950 text-emerald-400 border border-emerald-800 rounded">
              Live Connected
            </span>
          )}
        </div>
        <button
          onClick={() => setActiveScreen('dashboard')}
          className="text-amber-400 hover:text-amber-300 transition-colors flex items-center text-sm font-medium border border-amber-400/30 px-3 py-1 rounded bg-amber-400/10"
        >
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
          <TeamChat messages={teamChat} onSendMessage={handleSendMessage} />
        </div>
      </div>

      {/* Floating Elements */}
      {alerts.length > 0 && (
        <div className="absolute bottom-4 left-4 z-50 flex flex-col space-y-2">
          {alerts.map(alert => (
            <AlertToast key={alert.id} alert={alert} onAction={handleAlertAction} />
          ))}
        </div>
      )}

      {diffModalState && (
        <DiffViewer
          diff={diffModalState}
          onResolve={() => setDiffModalState(null)}
          onClose={() => setDiffModalState(null)}
        />
      )}
    </div>
  );
}

export default App;

import { lockRegistry } from './locks.js';

export function handleEvent(ws, wss, room, data) {
  if (data.type === 'ping') {
    if (data.peerId) {
      room.updatePing(data.peerId);
    }
    return;
  }

  if (data.type === 'lock:heartbeat') {
    lockRegistry.heartbeat(data.agentId || data.user);
    return;
  }

  if (data.type === 'file:sync') {
    const msgString = JSON.stringify({
      type: 'file:sync',
      origin: data.origin,
      relPath: data.relPath,
      content: data.content,
      timestamp: Date.now()
    });
    wss.clients.forEach(client => {
      if (client !== ws && client.readyState === 1) {
        client.send(msgString);
      }
    });
    return;
  }
  
  if (data.type === 'peer:join') {
    const peerId = data.user + '_' + Date.now();
    ws.peerId = peerId;
    room.addPeer(peerId, data.user, data.role, '127.0.0.1');
    
    broadcast(wss, { type: 'peer:update', peers: room.getMetadata().peers });
    broadcast(wss, {
      type: 'chat:message',
      user: 'SYSTEM',
      message: `${data.user} joined the room!`,
      timestamp: Date.now()
    });
    return;
  }
  
  if (data.type === 'chat:send') {
    broadcast(wss, {
      type: 'chat:message',
      user: data.user,
      message: sanitizeSecrets(data.message),
      timestamp: Date.now()
    });
    return;
  }

  if (data.type === 'agent:negotiate') {
    broadcast(wss, {
      type: 'agent:negotiate',
      fromUser: data.fromUser || 'Host',
      fromAgent: data.fromAgent || 'turf',
      toUser: data.toUser || 'All',
      toAgent: data.toAgent || 'cmdc',
      file: data.file,
      intent: data.intent || 'request_lock',
      message: sanitizeSecrets(data.message),
      timestamp: Date.now()
    });
    broadcast(wss, {
      type: 'chat:message',
      user: `🤖 [${(data.fromAgent || 'agent').toUpperCase()}]`,
      message: sanitizeSecrets(data.message),
      timestamp: Date.now(),
      isAgentNegotiation: true
    });
    return;
  }

  if (data.type === 'agent:status') {
    broadcast(wss, {
      type: 'agent:status',
      user: data.user || 'Unknown',
      agent: data.agent,
      status: data.status,
      details: data.details || '',
      task: data.task || '',
      timestamp: Date.now()
    });
    return;
  }

  if (data.type === 'peacemaker:diff') {
    broadcast(wss, {
      type: 'peacemaker:diff',
      file: data.file,
      agentA: data.agentA,
      agentB: data.agentB,
      merged: data.merged,
      astAudit: data.astAudit || { passed: true },
      timestamp: Date.now()
    });
    return;
  }

  if (data.type === 'agent:msg') {
    broadcast(wss, {
      type: 'agent:msg',
      tabId: data.tabId,
      agent: data.agent,
      message: sanitizeSecrets(data.message),
      timestamp: Date.now()
    });
    return;
  }
  
  const allowedTypes = ['intent:declare', 'tool:pre', 'tool:post', 'turn:complete', 'pty:input'];
  if (allowedTypes.includes(data.type)) {
     const safePayload = sanitizePayload(data.payload);
     const outType = mapTypeToBroadcast(data.type);
     
     broadcast(wss, {
       type: outType,
       originalType: data.type,
       payload: safePayload,
       user: data.user || 'Unknown',
       timestamp: Date.now()
     });
  }
}

function broadcast(wss, message) {
  const msgString = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(msgString);
    }
  });
}

const REDACTION_REGEX = /(?:sk-[a-zA-Z0-9]{48,}|ghp_[a-zA-Z0-9]{36}|Bearer\s+[a-zA-Z0-9\-._~+/]+=*|(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s]+)/g;

function sanitizeSecrets(text) {
  if (typeof text !== 'string') return text;
  return text.replace(REDACTION_REGEX, '[REDACTED_SECRET]');
}

function sanitizePayload(payload) {
  if (!payload) return payload;
  if (typeof payload === 'string') return sanitizeSecrets(payload);
  if (Array.isArray(payload)) return payload.map(item => sanitizePayload(item));
  if (typeof payload === 'object') {
    const safePayload = { ...payload };
    for (const key in safePayload) {
      safePayload[key] = sanitizePayload(safePayload[key]);
    }
    return safePayload;
  }
  return payload;
}

function mapTypeToBroadcast(type) {
  switch (type) {
    case 'intent:declare': return 'intent:declared';
    case 'tool:pre': return 'turf:claimed';
    case 'tool:post': return 'turf:resolved';
    default: return type;
  }
}

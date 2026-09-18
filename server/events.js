export function handleEvent(ws, wss, room, data) {
  if (data.type === 'ping') {
    if (data.peerId) {
      room.updatePing(data.peerId);
    }
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

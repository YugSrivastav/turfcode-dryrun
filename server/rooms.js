export function createRoom(hostName, repoPath) {
  const code = 'TRF-' + Math.random().toString(36).substring(2, 6).toUpperCase();
  const room = new Room(code, hostName, repoPath);
  return room;
}

export function connectToHost({ roomCode, userName }) {
  console.log(`Connecting to room ${roomCode} as ${userName}...`);
  console.log(`[✓] Joined room: ${roomCode}`);
  console.log('Launching your browser Cockpit...');
}

class Room {
  constructor(code, hostName, repoPath) {
    this.code = code;
    this.hostName = hostName;
    this.repoPath = repoPath;
    this.peers = new Map();
  }
  
  addPeer(peerId, name, role, ip) {
    this.peers.set(peerId, {
      name,
      role,
      ip,
      activeAgent: null,
      lastPing: Date.now()
    });
  }
  
  removePeer(peerId) {
    this.peers.delete(peerId);
  }
  
  updatePing(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.lastPing = Date.now();
    }
  }

  getMetadata() {
    return {
      code: this.code,
      hostName: this.hostName,
      repoPath: this.repoPath,
      peers: Array.from(this.peers.entries()).map(([id, p]) => ({ id, ...p }))
    };
  }
}

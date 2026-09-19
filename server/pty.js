import { spawn } from 'child_process';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let ptyMod;
try {
    ptyMod = require('node-pty');
} catch (e) {
    ptyMod = null;
}

export function spawnAgent(agentType, envOptions, onData, onExit) {
    const env = {
        ...process.env,
        TURF_ROOM: envOptions.roomCode,
        TURF_DAEMON: envOptions.daemonUrl,
        TURF_USER: envOptions.user,
        TURF_AGENT_ID: envOptions.agentId,
    };

    let cmd = agentType;
    if (!agentType || agentType === 'shell') {
        cmd = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
    }

    if (ptyMod) {
        const ptyProcess = ptyMod.spawn(cmd, [], {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            cwd: envOptions.cwd || process.cwd(),
            env: env
        });

        ptyProcess.onData((data) => onData(data));
        ptyProcess.onExit(({ exitCode }) => onExit(exitCode));
        return {
            write: (data) => ptyProcess.write(data),
            kill: () => ptyProcess.kill()
        };
    } else {
        const cp = spawn(cmd, {
            shell: true,
            cwd: envOptions.cwd || process.cwd(),
            env: env
        });

        cp.stdout.on('data', (data) => onData(data.toString()));
        cp.stderr.on('data', (data) => onData(data.toString()));
        cp.on('exit', (code) => onExit(code));

        return {
            write: (data) => cp.stdin.write(data),
            kill: () => cp.kill()
        };
    }
}

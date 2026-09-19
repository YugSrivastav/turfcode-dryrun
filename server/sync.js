import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  '.turf',
  'dist',
  '.env',
  'turf-error.log'
];

/**
 * Creates a standard 512-byte POSIX USTAR tar header block
 */
function createTarHeader(relativePath, size, mtime = Date.now()) {
  const buf = Buffer.alloc(512);
  const normalizedPath = relativePath.replace(/\\/g, '/');

  // Name (0..99)
  buf.write(normalizedPath.slice(0, 100), 0, 100, 'utf8');

  // Mode (100..107): 0000644\0
  buf.write('0000644\0', 100, 8, 'ascii');

  // UID (108..115): 0000000\0
  buf.write('0000000\0', 108, 8, 'ascii');

  // GID (116..123): 0000000\0
  buf.write('0000000\0', 116, 8, 'ascii');

  // Size (124..135): 11 octal digits + null
  const sizeOctal = size.toString(8).padStart(11, '0') + '\0';
  buf.write(sizeOctal, 124, 12, 'ascii');

  // Mtime (136..143): 11 octal digits + null
  const mtimeOctal = Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0';
  buf.write(mtimeOctal, 136, 12, 'ascii');

  // Checksum field placeholder: 8 spaces (144..151)
  buf.fill(0x20, 144, 152);

  // Typeflag (156): '0' (regular file)
  buf[156] = 0x30;

  // Magic (257..262): ustar\0
  buf.write('ustar\0', 257, 6, 'ascii');

  // Version (263..264): 00
  buf.write('00', 263, 2, 'ascii');

  // Compute unsigned sum of all 512 bytes
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += buf[i];
  }

  // Format checksum as 6 octal digits + null + space
  const chkOctal = checksum.toString(8).padStart(6, '0') + '\0 ';
  buf.write(chkOctal, 144, 8, 'ascii');

  return buf;
}

/**
 * Packs a directory into a .tar.gz buffer in memory
 */
export function packDirectoryToTarGz(sourceDir, excludes = DEFAULT_EXCLUDES) {
  const blocks = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (excludes.includes(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(sourceDir, fullPath);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const content = fs.readFileSync(fullPath);
          const stat = fs.statSync(fullPath);
          const header = createTarHeader(relPath, content.length, stat.mtimeMs);
          blocks.push(header);
          blocks.push(content);

          const remainder = content.length % 512;
          if (remainder > 0) {
            blocks.push(Buffer.alloc(512 - remainder));
          }
        } catch (e) {
          // Ignore unreadable files
        }
      }
    }
  }

  walk(sourceDir);

  // Two 512-byte zero blocks mark end of tar archive
  blocks.push(Buffer.alloc(1024));

  const tarBuffer = Buffer.concat(blocks);
  return zlib.gzipSync(tarBuffer);
}

/**
 * Unpacks a .tar.gz buffer into a target directory
 */
export function unpackTarGzToDirectory(tarGzBuffer, targetDir) {
  const tarBuffer = zlib.gunzipSync(tarGzBuffer);
  let offset = 0;
  const writtenFiles = [];

  fs.mkdirSync(targetDir, { recursive: true });

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    offset += 512;

    // End of archive is marked by empty block
    if (header.every(b => b === 0)) break;

    // Read filename
    let nullIdx = header.indexOf(0, 0);
    if (nullIdx === -1 || nullIdx > 100) nullIdx = 100;
    const name = header.toString('utf8', 0, nullIdx).trim();
    if (!name) continue;

    // Read size (124..135)
    const sizeStr = header.toString('ascii', 124, 135).replace(/\0/g, '').trim();
    const size = parseInt(sizeStr, 8) || 0;

    // Read content
    const content = tarBuffer.subarray(offset, offset + size);
    offset += size;

    // Padding to next 512-byte boundary
    const remainder = size % 512;
    if (remainder > 0) {
      offset += (512 - remainder);
    }

    const destPath = path.join(targetDir, name);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, content);
    writtenFiles.push(name);
  }

  return writtenFiles;
}

/**
 * Downloads and synchronizes workspace from host daemon
 */
export async function syncWorkspaceFromHost(hostAddress, port, targetDir) {
  const url = `http://${hostAddress}:${port}/api/room/sync`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`Failed to sync workspace from host: HTTP ${res.status}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  return unpackTarGzToDirectory(buffer, targetDir);
}

#!/usr/bin/env node
/**
 * WhatsApp bridge entry point.
 * Connects to WhatsApp via Baileys, then bridges messages to Claude.
 */
import 'dotenv/config';
import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WhatsAppBridge } from './bridge.js';


import http from 'http';

let qrServer: http.Server | null = null;
let latestQrData = '';

/** Start a local HTTP server showing the QR code. Auto-closes after pairing. */
function serveQrCode(qrData: string): void {
  latestQrData = qrData;

  if (qrServer) return; // already running, just update qrData

  const QR_PORT = parseInt(process.env.WA_QR_PORT ?? '18790');

  qrServer = http.createServer(async (_req, res) => {
    try {
      const QRCode = await import('qrcode');
      const svgString = await QRCode.default.toString(latestQrData, { type: 'svg', width: 300 });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html><head><title>Claw CLI — WhatsApp QR</title>
<meta http-equiv="refresh" content="20">
<style>body{font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#111;color:#fff}
h1{font-size:1.4em;margin-bottom:0.3em}p{color:#aaa;font-size:0.9em}svg{background:#fff;padding:16px;border-radius:12px}</style>
</head><body>
<h1>Claw CLI — WhatsApp Pairing</h1>
<p>Scan with WhatsApp → Settings → Linked Devices → Link a Device</p>
${svgString}
<p style="margin-top:1em;font-size:0.8em">Page refreshes automatically. Close after pairing.</p>
</body></html>`);
    } catch {
      res.writeHead(500);
      res.end('QR generation failed');
    }
  });

  qrServer.listen(QR_PORT, () => {
    console.log(`[wa] 📱 QR code: http://localhost:${QR_PORT}`);
  });
}

function closeQrServer(): void {
  if (qrServer) {
    qrServer.close();
    qrServer = null;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', '..', 'data');
const LOCK_FILE = join(DATA_DIR, 'whatsapp-bridge.lock');

function ensureSingleton(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(LOCK_FILE)) {
    const oldPid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim());
    if (!isNaN(oldPid) && oldPid > 0 && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0);
        console.log(`[wa] Killing previous instance (pid ${oldPid})`);
        process.kill(oldPid, 'SIGTERM');
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          try { process.kill(oldPid, 0); } catch { break; }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
        try { process.kill(oldPid, 'SIGKILL'); } catch { /* dead */ }
      } catch { /* stale lock */ }
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  console.log(`[wa] Lock acquired (pid ${process.pid})`);
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim());
      if (pid === process.pid) unlinkSync(LOCK_FILE);
    }
  } catch { /* ok */ }
}

async function main() {
  ensureSingleton();

  const ownerPhone = process.env.WA_OWNER_PHONE;
  if (!ownerPhone) {
    console.error('[wa] Missing WA_OWNER_PHONE in .env');
    process.exit(1);
  }

  const sessionDir = process.env.WA_SESSION_DIR ?? join(DATA_DIR, 'whatsapp-session');
  mkdirSync(sessionDir, { recursive: true });

  const bridge = new WhatsAppBridge({
    ownerPhone,
    claudePath: process.env.CLAUDE_PATH ?? 'claude',
    claudeCwd: process.env.CLAUDE_CWD ?? process.cwd(),
    claudeTimeout: parseInt(process.env.CLAUDE_TIMEOUT ?? '120000'),
  });

  // Dynamic import of Baileys
  let baileys: any;
  try {
    baileys = await import('@whiskeysockets/baileys');
  } catch {
    console.error('[wa] @whiskeysockets/baileys not installed. Run: npm install @whiskeysockets/baileys');
    process.exit(1);
  }
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    DisconnectReason,
  } = baileys;

  let qrTerminal: any;
  try {
    qrTerminal = await import('qrcode-terminal');
  } catch { /* optional */ }

  // Create a pino-compatible silent logger (Baileys needs it for makeCacheableSignalKeyStore)
  const pino = (await import('pino')).default;
  const logger = pino({ level: 'silent' });

  async function connectWA() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[wa] Baileys version: ${version.join('.')}`);

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version,
      logger,
      browser: ['Claw CLI', 'Chrome', '20.0'],
      printQRInTerminal: false,
      syncFullHistory: true,
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    // Inject historical messages received during sync
    sock.ev.on('messaging-history.set', ({ messages }: { messages: any[] }) => {
      bridge.injectHistoryMessages(messages ?? []);
    });

    if (sock.ws && typeof sock.ws.on === 'function') {
      sock.ws.on('error', (err: Error) => console.error('[wa] WebSocket error:', err.message));
    }

    // Wait for connection to fully open, then start bridge
    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        serveQrCode(qr);
      }
      if (connection === 'open') {
        closeQrServer();
        console.log('[wa] Connected to WhatsApp');
        if (sock.user?.id) {
          bridge.addOwnerJid(sock.user.id);
          const bare = sock.user.id.replace(/:\d+@/, '@');
          bridge.addOwnerJid(bare);
        }
        try { await sock.sendPresenceUpdate('available'); } catch {}
        bridge.start(sock);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          console.log('[wa] Disconnected, reconnecting...');
          setTimeout(connectWA, 3000);
        } else {
          console.log('[wa] Logged out. Delete session dir and restart.');
          process.exit(0);
        }
      }
    });
  }

  const shutdown = () => {
    console.log('\n[wa] Shutting down...');
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await connectWA();
}

main().catch((err) => {
  console.error('[wa] Fatal:', err);
  releaseLock();
  process.exit(1);
});

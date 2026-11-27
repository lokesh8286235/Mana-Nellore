// Mana Nellore — HTTPS database backup endpoint (prepared 2026-10-21).
//
// WHY: the proactivity sandbox cannot open raw TCP to the Railway Postgres
// proxy, so the daily backup cron has NEVER produced a file. This endpoint
// lets the backend (which CAN reach the DB) produce the same JSON dump and
// serve it gzipped over HTTPS; the cron then just downloads it.
//
// SECURITY: static token auth. The cron sends the BACKUP_TOKEN env value as
// the `x-backup-token` header. The token never appears in URLs (which land in
// access logs), never in git, and this endpoint never logs it. Read-only:
// it cannot change any data.
const express = require('express');
const zlib = require('zlib');
const db = require('../db');
const secure = require('../lib/secure');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const expected = process.env.BACKUP_TOKEN;
    const given = req.headers['x-backup-token'];
    if (!expected || !given || given !== expected) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { rows: tables } = await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    const backup = { backed_up_at: new Date().toISOString(), tables: {} };
    for (const { tablename } of tables) {
      // tablename comes from pg_tables (not user input), so this is safe.
      const { rows } = await db.query(`SELECT * FROM "${tablename}"`);
      backup.tables[tablename] = rows;
    }
    const gzipped = zlib.gzipSync(JSON.stringify(backup));
    // Backups are encrypted when DATA_ENC_KEY is set (AES-256-GCM, see
    // src/lib/secure.js). Without the key the gzip is served plain
    // (dual-read) and a warning is logged. Decrypt a downloaded file with
    // ~/workspace/backup-tools/decrypt-backup.js (key from
    // ~/workspace/.secrets/data_enc_key.txt). Sensitive field VALUES inside
    // the dump are ciphertext regardless (encrypted at rest in the DB).
    const body = secure.encryptBuffer(gzipped);
    const encrypted = body !== gzipped;
    res.setHeader('Content-Type', encrypted ? 'application/octet-stream' : 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="mana-nellore-backup.json.gz${encrypted ? '.enc' : ''}"`);
    if (encrypted) res.setHeader('X-Backup-Encrypted', '1');
    res.send(body);
  } catch (err) {
    console.error('backup endpoint failed:', err.message);
    res.status(500).json({ error: 'backup failed' });
  }
});

module.exports = router;

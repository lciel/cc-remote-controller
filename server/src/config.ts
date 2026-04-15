import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';

const ROOT_DIR = path.resolve(import.meta.dirname, '../..');

dotenv.config({ path: path.resolve(ROOT_DIR, '.env') });

const envToken = (process.env.AUTH_TOKEN || '').trim();
const authTokenGenerated = !envToken;

const sslCert = (process.env.SSL_CERT_PATH || '').trim();
const sslKey = (process.env.SSL_KEY_PATH || '').trim();
const sslEnabled = sslCert && sslKey;

export const config = {
  port: parseInt(process.env.PORT || '8787', 10),
  authToken: envToken || crypto.randomUUID(),
  authTokenGenerated,
  hostUrl: (process.env.HOST_URL || '').trim(),
  dbPath: path.resolve(ROOT_DIR, process.env.DB_PATH || './data/sessions.db'),
  claudePath: (process.env.CLAUDE_PATH || '').trim() || 'claude',
  ssl: sslEnabled ? {
    certPath: path.resolve(ROOT_DIR, sslCert),
    keyPath: path.resolve(ROOT_DIR, sslKey),
  } : null,
};

import dotenv from 'dotenv';
import path from 'path';

const ROOT_DIR = path.resolve(import.meta.dirname, '../..');

dotenv.config({ path: path.resolve(ROOT_DIR, '.env') });

export const config = {
  port: parseInt(process.env.PORT || '8787', 10),
  authToken: process.env.AUTH_TOKEN || '',
  dbPath: path.resolve(ROOT_DIR, process.env.DB_PATH || './data/sessions.db'),
};

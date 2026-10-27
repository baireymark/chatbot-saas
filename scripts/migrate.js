import fs from 'node:fs';
import pg from 'pg';

const sql = fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query(sql);
  console.log('Schema applied.');
} finally {
  await client.end();
}

/** Explicit local bootstrap for an existing account. Never creates passwords. */
import { Pool } from 'pg';
if (process.env.NODE_ENV === 'production')
  throw new Error('Use your reviewed production operator workflow, not the development bootstrap.');
const email = process.argv[process.argv.indexOf('--email') + 1];
if (!process.argv.includes('--email') || !email || !email.includes('@'))
  throw new Error('Usage: npm run admin:grant -- --email your-existing-account@example.com');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await db.connect();
try {
  await client.query('BEGIN');
  const result = await client.query(
    "UPDATE users SET role='admin' WHERE email=$1 AND deleted_at IS NULL RETURNING id",
    [email.toLowerCase()],
  );
  if (!result.rows[0])
    throw new Error('Account not found. Register through the application first.');
  await client.query(
    'INSERT INTO audit(actor_id,action,target_id,details) VALUES($1::uuid,$2,$1::text,$3)',
    [
      result.rows[0].id,
      'operator.local_admin_grant',
      JSON.stringify({ source: 'explicit-local-cli' }),
    ],
  );
  await client.query('COMMIT');
  console.log(
    'Administrator role granted to the existing local account and recorded in audit. Refresh the application.',
  );
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await db.end();
}

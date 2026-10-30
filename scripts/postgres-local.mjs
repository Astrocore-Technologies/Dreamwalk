/** Developer-only, real PostgreSQL. No external resources or known credentials. */
import EmbeddedPostgres from 'embedded-postgres';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function startLocalPostgres() {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Local database bootstrap is forbidden in production.');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cluster = process.env.LOCAL_POSTGRES_CLUSTER || 'preview';
  if (!/^[a-z0-9-]{1,60}$/.test(cluster)) throw new Error('Invalid local cluster name');
  const local = path.join(root, '.local', cluster);
  mkdirSync(local, { recursive: true, mode: 0o700 });
  const credentialsPath = path.join(local, 'database.json');
  const credentials = existsSync(credentialsPath)
    ? JSON.parse(readFileSync(credentialsPath, 'utf8'))
    : {
        user: 'dreamwalk',
        password: randomBytes(32).toString('hex'),
        port: Number(process.env.LOCAL_POSTGRES_PORT || 55432),
        database: 'dreamwalk',
      };
  if (!Number.isInteger(credentials.port) || credentials.port < 1024 || credentials.port > 65535)
    throw new Error('Invalid LOCAL_POSTGRES_PORT');
  writeFileSync(credentialsPath, JSON.stringify(credentials), { mode: 0o600 });
  chmodSync(credentialsPath, 0o600);
  const url = `postgresql://${credentials.user}:${credentials.password}@127.0.0.1:${credentials.port}/${credentials.database}`;
  writeFileSync(path.join(local, 'database.env'), `DATABASE_URL=${url}\n`, { mode: 0o600 });
  const log = (message) =>
    appendFileSync(path.join(local, 'postgres.log'), `${new Date().toISOString()} ${message}\n`, {
      mode: 0o600,
    });
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(local, 'postgres'),
    user: credentials.user,
    password: credentials.password,
    port: credentials.port,
    persistent: true,
    authMethod: 'scram-sha-256',
    // TCP-only avoids unsupported Unix socket files on managed workspace filesystems.
    postgresFlags: ['-h', '127.0.0.1', '-c', 'unix_socket_directories='],
    onLog: log,
    onError: log,
  });
  if (!existsSync(path.join(local, 'postgres', 'PG_VERSION'))) await pg.initialise();
  const pidFile = path.join(local, 'postgres', 'postmaster.pid');
  if (existsSync(pidFile)) {
    throw new Error(
      `Local cluster ${cluster} has a postmaster.pid lock. Stop its owning process and wait for a clean shutdown. No lock or data was removed. See .local/${cluster}/postgres.log.`,
    );
  }
  await pg.start();
  const originalStop = pg.stop.bind(pg);
  let stopping;
  pg.stop = () =>
    (stopping ||= (async () => {
      // EmbeddedPostgres waits for the child exit; additionally require durable lock cleanup.
      await originalStop();
      for (let attempt = 0; attempt < 120 && existsSync(pidFile); attempt++) await delay(250);
      if (existsSync(pidFile))
        throw new Error(
          `PostgreSQL exited but ${cluster} lock remains. Preserve data and inspect its log before restarting.`,
        );
    })());
  const client = pg.getPgClient('postgres', '127.0.0.1');
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [
      credentials.database,
    ]);
    if (!exists.rowCount) await client.query('CREATE DATABASE dreamwalk');
    const version = await client.query('SHOW server_version');
    console.log(
      `PostgreSQL ${version.rows[0].server_version} ready on 127.0.0.1:${credentials.port}.`,
    );
    console.log(`Connection configuration: .local/${cluster}/database.env (private, gitignored).`);
  } finally {
    await client.end();
  }
  process.env.DATABASE_URL = url;
  return pg;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pg = await startLocalPostgres();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

// Metadatos de Flex Cloud en SQLite (node:sqlite, sin dependencias). Los
// BYTES de los archivos nunca entran aqui: viven en el almacen de objetos.
//
// Por que SQLite: transacciones ACID locales para la cuota. Reservar espacio
// para una subida es "leer usado+reservado, comprobar, sumar" y tiene que ser
// atomico aunque lleguen diez subidas a la vez. DatabaseSync ejecuta cada
// transaccion sin ceder el hilo, asi que dos peticiones no pueden intercalarse
// dentro de una.
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  // v1
  `
  CREATE TABLE accounts (
    id              TEXT PRIMARY KEY,
    flex_address    TEXT,
    display_name    TEXT,
    plan            TEXT NOT NULL,
    quota_override  INTEGER,
    used_bytes      INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
    reserved_bytes  INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE TABLE folders (
    id           TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL REFERENCES accounts(id),
    parent_id    TEXT REFERENCES folders(id),
    name         TEXT NOT NULL,
    name_key     TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER,
    trash_root   INTEGER NOT NULL DEFAULT 0,
    trash_batch  TEXT
  );
  CREATE UNIQUE INDEX folders_live_name ON folders(account_id, IFNULL(parent_id, ''), name_key) WHERE deleted_at IS NULL;
  CREATE INDEX folders_parent ON folders(account_id, parent_id);
  CREATE INDEX folders_batch ON folders(trash_batch);

  CREATE TABLE files (
    id                TEXT PRIMARY KEY,
    account_id        TEXT NOT NULL REFERENCES accounts(id),
    parent_id         TEXT REFERENCES folders(id),
    name              TEXT NOT NULL,
    name_key          TEXT NOT NULL,
    storage_key       TEXT NOT NULL UNIQUE,
    storage_location  TEXT NOT NULL DEFAULT 'local',
    size              INTEGER NOT NULL CHECK (size >= 0),
    mime              TEXT NOT NULL,
    kind              TEXT NOT NULL,
    sha256            TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'ready',
    version           INTEGER NOT NULL DEFAULT 1,
    source            TEXT NOT NULL DEFAULT 'web',
    metadata          TEXT,
    thumb_key         TEXT,
    thumb_mime        TEXT,
    thumb_size        INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    deleted_at        INTEGER,
    trash_root        INTEGER NOT NULL DEFAULT 0,
    trash_batch       TEXT
  );
  CREATE UNIQUE INDEX files_live_name ON files(account_id, IFNULL(parent_id, ''), name_key) WHERE deleted_at IS NULL;
  CREATE INDEX files_parent ON files(account_id, parent_id);
  CREATE INDEX files_recent ON files(account_id, updated_at);
  CREATE INDEX files_batch ON files(trash_batch);

  CREATE TABLE uploads (
    id              TEXT PRIMARY KEY,
    account_id      TEXT NOT NULL REFERENCES accounts(id),
    parent_id       TEXT,
    name            TEXT NOT NULL,
    mime            TEXT NOT NULL,
    size            INTEGER NOT NULL,
    chunk_size      INTEGER NOT NULL,
    total_parts     INTEGER NOT NULL,
    received_bytes  INTEGER NOT NULL DEFAULT 0,
    sha256          TEXT,
    client_key      TEXT,
    state           TEXT NOT NULL,
    reserved_bytes  INTEGER NOT NULL,
    storage_key     TEXT NOT NULL,
    file_id         TEXT,
    source          TEXT NOT NULL DEFAULT 'web',
    metadata        TEXT,
    error           TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL
  );
  CREATE INDEX uploads_account ON uploads(account_id, state);
  CREATE INDEX uploads_client ON uploads(account_id, client_key);
  CREATE INDEX uploads_expiry ON uploads(state, expires_at);

  CREATE TABLE upload_parts (
    upload_id    TEXT NOT NULL REFERENCES uploads(id),
    part_number  INTEGER NOT NULL,
    size         INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    received_at  INTEGER NOT NULL,
    PRIMARY KEY (upload_id, part_number)
  );

  -- Solo modo dev (FLEX_ACCOUNT_MODE=dev): identidades locales para probar la
  -- web sin el Flex Account real. En modo remote estas tablas no se usan.
  CREATE TABLE dev_accounts (
    id            TEXT PRIMARY KEY,
    flex_address  TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    plan          TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE dev_sessions (
    token_hash  TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES dev_accounts(id),
    expires_at  INTEGER NOT NULL
  );
  CREATE TABLE dev_devices (
    token_hash  TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES dev_accounts(id),
    label       TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'active',
    expires_at  INTEGER
  );
  `,
];

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return wrap(db);
}

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

function wrap(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  let depth = 0;
  return {
    raw: db,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    // Transaccion sincrona. NUNCA se puede pasar una funcion async: un await
    // dentro soltaria el hilo con la transaccion abierta.
    tx(fn) {
      if (depth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const r = fn();
        if (r && typeof r.then === 'function') throw new Error('tx() no admite funciones async');
        db.exec('COMMIT');
        return r;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* ya revertida */ }
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}

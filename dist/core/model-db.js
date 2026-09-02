/**
 * model-db.ts — The Model SQLite writer (shared core).
 *
 * Owns the `<game>.autopsy.db` file: the single, portable, per-game persistent
 * understanding the whole Autopsy Engine reads and writes. This module is the
 * ONLY thing that knows the on-disk schema (MODEL_SCHEMA.md V1 subset).
 *
 * Design contract (PR-1):
 *  - better-sqlite3, synchronous. One file per game.
 *  - CREATE TABLE IF NOT EXISTS for game / binary / asset / data_store, every
 *    fact-bearing row carrying provenance + source_tool columns.
 *  - Idempotent writes: UNIQUE natural keys + INSERT ... ON CONFLICT DO UPDATE,
 *    so re-running unpack_game never duplicates rows (append-and-confirm).
 *  - WAL journal mode for crash safety.
 *  - Read-only with respect to GAME files. The only thing this writes is the
 *    .autopsy.db itself.
 */
import Database from 'better-sqlite3';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
/**
 * The schema version this writer emits. Stored on the game row.
 *  v1 (PR-0): game / binary / asset / data_store.
 *  v2 (PR-3): + function / xref / symbol (ADDITIVE — v1 tables untouched; existing
 *             .autopsy.db files gain the empty new tables via CREATE TABLE IF NOT EXISTS).
 */
export const AUTOPSY_SCHEMA_VERSION = 2;
/**
 * AutopsyModel — opens/creates a `<game>.autopsy.db` and writes the V1 tables.
 *
 * Usage:
 *   const model = new AutopsyModel('C:/.../MyGame.autopsy.db');
 *   const gameId = model.upsertGame({ ... });
 *   model.addBinary({ game_id: gameId, ... });
 *   ...
 *   model.close();
 */
export class AutopsyModel {
    db;
    dbPath;
    constructor(dbPath) {
        this.dbPath = dbPath;
        // Ensure the containing directory exists (.autopsy/ dir or sibling of game).
        const dir = dirname(dbPath);
        if (dir && !existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        this.db = new Database(dbPath);
        // WAL for crash safety + concurrent reads while we append.
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        // Reasonable durability without the full-fsync cost on every statement.
        this.db.pragma('synchronous = NORMAL');
        this.createSchema();
    }
    /** Create the V1 tables (idempotent). Called on every open. */
    createSchema() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS game (
        id              INTEGER PRIMARY KEY,
        name            TEXT    NOT NULL,
        install_path    TEXT    NOT NULL,
        engine          TEXT,
        runtime         TEXT,
        arch            TEXT,
        package_type    TEXT,
        autopsy_version INTEGER NOT NULL,
        provenance      TEXT    NOT NULL DEFAULT 'inferred',
        source_tool     TEXT    NOT NULL DEFAULT 'unpack_game',
        created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE (install_path)
      );

      CREATE TABLE IF NOT EXISTS binary (
        id          INTEGER PRIMARY KEY,
        game_id     INTEGER NOT NULL REFERENCES game(id) ON DELETE CASCADE,
        path        TEXT    NOT NULL,
        kind        TEXT    NOT NULL,
        managed     INTEGER NOT NULL DEFAULT 0,
        arch        TEXT,
        size        INTEGER NOT NULL DEFAULT 0,
        sha256      TEXT,
        role        TEXT,
        notes       TEXT,
        provenance  TEXT    NOT NULL DEFAULT 'inferred',
        source_tool TEXT    NOT NULL DEFAULT 'unpack_game',
        UNIQUE (game_id, path)
      );

      CREATE TABLE IF NOT EXISTS asset (
        id             INTEGER PRIMARY KEY,
        game_id        INTEGER NOT NULL REFERENCES game(id) ON DELETE CASCADE,
        container_path TEXT    NOT NULL,
        internal_path  TEXT    NOT NULL DEFAULT '',
        type           TEXT    NOT NULL DEFAULT 'other',
        format         TEXT,
        decoded        INTEGER NOT NULL DEFAULT 0,
        decoded_path   TEXT,
        size           INTEGER NOT NULL DEFAULT 0,
        notes          TEXT,
        provenance     TEXT    NOT NULL DEFAULT 'inferred',
        source_tool    TEXT    NOT NULL DEFAULT 'unpack_game',
        UNIQUE (game_id, container_path, internal_path)
      );

      CREATE TABLE IF NOT EXISTS data_store (
        id           INTEGER PRIMARY KEY,
        game_id      INTEGER NOT NULL REFERENCES game(id) ON DELETE CASCADE,
        path         TEXT    NOT NULL,
        kind         TEXT    NOT NULL,
        scope        TEXT,
        schema_known INTEGER NOT NULL DEFAULT 0,
        notes        TEXT,
        provenance   TEXT    NOT NULL DEFAULT 'inferred',
        source_tool  TEXT    NOT NULL DEFAULT 'unpack_game',
        UNIQUE (game_id, path)
      );

      CREATE INDEX IF NOT EXISTS idx_binary_game     ON binary(game_id);
      CREATE INDEX IF NOT EXISTS idx_asset_game      ON asset(game_id);
      CREATE INDEX IF NOT EXISTS idx_asset_type      ON asset(game_id, type);
      CREATE INDEX IF NOT EXISTS idx_data_store_game ON data_store(game_id);
    `);
        // ── Schema v2 (PR-3, V3 Native Comprehension) — ADDITIVE ────────────────
        // New tables only. The v1 block above is byte-for-byte unchanged, so existing
        // .autopsy.db files simply gain these three empty tables on next open.
        // NB: "function" is a SQL keyword — the identifier is double-quoted everywhere.
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS "function" (
        id          INTEGER PRIMARY KEY,
        binary_id   INTEGER NOT NULL REFERENCES binary(id) ON DELETE CASCADE,
        rva         INTEGER NOT NULL,
        size        INTEGER NOT NULL DEFAULT 0,
        insn_count  INTEGER NOT NULL DEFAULT 0,
        name        TEXT,
        label       TEXT,
        notes       TEXT,
        provenance  TEXT    NOT NULL DEFAULT 'inferred',
        source_tool TEXT    NOT NULL DEFAULT 'disassemble_function',
        UNIQUE (binary_id, rva)
      );

      CREATE TABLE IF NOT EXISTS xref (
        id          INTEGER PRIMARY KEY,
        binary_id   INTEGER NOT NULL REFERENCES binary(id) ON DELETE CASCADE,
        from_rva    INTEGER NOT NULL,
        to_rva      INTEGER NOT NULL,
        kind        TEXT    NOT NULL,
        mnemonic    TEXT,
        notes       TEXT,
        provenance  TEXT    NOT NULL DEFAULT 'verified',
        source_tool TEXT    NOT NULL DEFAULT 'build_call_graph',
        UNIQUE (binary_id, from_rva, to_rva, kind)
      );

      CREATE TABLE IF NOT EXISTS symbol (
        id          INTEGER PRIMARY KEY,
        binary_id   INTEGER NOT NULL REFERENCES binary(id) ON DELETE CASCADE,
        rva         INTEGER NOT NULL,
        name        TEXT    NOT NULL,
        kind        TEXT    NOT NULL,
        notes       TEXT,
        provenance  TEXT    NOT NULL DEFAULT 'verified',
        source_tool TEXT    NOT NULL DEFAULT 'ingest_pdb',
        UNIQUE (binary_id, rva, kind)
      );

      CREATE INDEX IF NOT EXISTS idx_function_binary ON "function"(binary_id);
      CREATE INDEX IF NOT EXISTS idx_xref_binary     ON xref(binary_id);
      CREATE INDEX IF NOT EXISTS idx_xref_to         ON xref(binary_id, to_rva);
      CREATE INDEX IF NOT EXISTS idx_symbol_binary   ON symbol(binary_id);
    `);
    }
    /**
     * Insert-or-update the single game header row, keyed by install_path.
     * Returns the game_id (stable across re-runs — append-and-confirm, A6).
     */
    upsertGame(input) {
        const stmt = this.db.prepare(`
      INSERT INTO game (
        name, install_path, engine, runtime, arch, package_type,
        autopsy_version, provenance, source_tool
      ) VALUES (
        @name, @install_path, @engine, @runtime, @arch, @package_type,
        @autopsy_version, @provenance, @source_tool
      )
      ON CONFLICT (install_path) DO UPDATE SET
        name            = excluded.name,
        engine          = excluded.engine,
        runtime         = excluded.runtime,
        arch            = excluded.arch,
        package_type    = excluded.package_type,
        autopsy_version = excluded.autopsy_version,
        provenance      = excluded.provenance,
        source_tool     = excluded.source_tool
      RETURNING id
    `);
        const row = stmt.get({
            name: input.name,
            install_path: input.install_path,
            engine: input.engine,
            runtime: input.runtime,
            arch: input.arch,
            package_type: input.package_type,
            autopsy_version: input.autopsy_version,
            provenance: input.provenance,
            source_tool: input.source_tool,
        });
        if (!row) {
            throw new Error('upsertGame: INSERT ... RETURNING id produced no row');
        }
        return row.id;
    }
    /**
     * Insert-or-update a binary, keyed by (game_id, path). Idempotent (A6).
     * Returns the binary id.
     */
    addBinary(input) {
        const stmt = this.db.prepare(`
      INSERT INTO binary (
        game_id, path, kind, managed, arch, size, sha256, role, notes,
        provenance, source_tool
      ) VALUES (
        @game_id, @path, @kind, @managed, @arch, @size, @sha256, @role, @notes,
        @provenance, @source_tool
      )
      ON CONFLICT (game_id, path) DO UPDATE SET
        kind        = excluded.kind,
        managed     = excluded.managed,
        arch        = excluded.arch,
        size        = excluded.size,
        sha256      = excluded.sha256,
        role        = excluded.role,
        notes       = excluded.notes,
        provenance  = excluded.provenance,
        source_tool = excluded.source_tool
      RETURNING id
    `);
        const row = stmt.get({
            game_id: input.game_id,
            path: input.path,
            kind: input.kind,
            managed: input.managed ? 1 : 0,
            arch: input.arch,
            size: input.size,
            sha256: input.sha256,
            role: input.role,
            notes: input.notes,
            provenance: input.provenance,
            source_tool: input.source_tool,
        });
        if (!row) {
            throw new Error('addBinary: INSERT ... RETURNING id produced no row');
        }
        return row.id;
    }
    /**
     * Insert-or-update an asset, keyed by (game_id, container_path, internal_path).
     * Idempotent (A6). Unknown files arrive here as type='other' with a reason in
     * notes — they are catalogued, never dropped (A3). Returns the asset id.
     */
    addAsset(input) {
        const stmt = this.db.prepare(`
      INSERT INTO asset (
        game_id, container_path, internal_path, type, format, decoded,
        decoded_path, size, notes, provenance, source_tool
      ) VALUES (
        @game_id, @container_path, @internal_path, @type, @format, @decoded,
        @decoded_path, @size, @notes, @provenance, @source_tool
      )
      ON CONFLICT (game_id, container_path, internal_path) DO UPDATE SET
        type         = excluded.type,
        format       = excluded.format,
        decoded      = excluded.decoded,
        decoded_path = excluded.decoded_path,
        size         = excluded.size,
        notes        = excluded.notes,
        provenance   = excluded.provenance,
        source_tool  = excluded.source_tool
      RETURNING id
    `);
        const row = stmt.get({
            game_id: input.game_id,
            container_path: input.container_path,
            internal_path: input.internal_path ?? '',
            type: input.type,
            format: input.format,
            decoded: input.decoded ? 1 : 0,
            decoded_path: input.decoded_path,
            size: input.size,
            notes: input.notes,
            provenance: input.provenance,
            source_tool: input.source_tool,
        });
        if (!row) {
            throw new Error('addAsset: INSERT ... RETURNING id produced no row');
        }
        return row.id;
    }
    /**
     * Insert-or-update a data_store, keyed by (game_id, path). Idempotent (A6).
     * Containers (.pak/.bundle/.pck) may land here as kind='binary-blob' rather
     * than being walked as Unity (A7). Returns the data_store id.
     */
    addDataStore(input) {
        const stmt = this.db.prepare(`
      INSERT INTO data_store (
        game_id, path, kind, scope, schema_known, notes,
        provenance, source_tool
      ) VALUES (
        @game_id, @path, @kind, @scope, @schema_known, @notes,
        @provenance, @source_tool
      )
      ON CONFLICT (game_id, path) DO UPDATE SET
        kind         = excluded.kind,
        scope        = excluded.scope,
        schema_known = excluded.schema_known,
        notes        = excluded.notes,
        provenance   = excluded.provenance,
        source_tool  = excluded.source_tool
      RETURNING id
    `);
        const row = stmt.get({
            game_id: input.game_id,
            path: input.path,
            kind: input.kind,
            scope: input.scope,
            schema_known: input.schema_known ? 1 : 0,
            notes: input.notes,
            provenance: input.provenance,
            source_tool: input.source_tool,
        });
        if (!row) {
            throw new Error('addDataStore: INSERT ... RETURNING id produced no row');
        }
        return row.id;
    }
    /**
     * Insert-or-update a function, keyed by (binary_id, rva). Idempotent (A6).
     * PR-3.1 writes the disassembled region's extent; name/label fill in later
     * slices. Returns the function id.
     */
    addFunction(input) {
        const stmt = this.db.prepare(`
      INSERT INTO "function" (
        binary_id, rva, size, insn_count, name, label, notes,
        provenance, source_tool
      ) VALUES (
        @binary_id, @rva, @size, @insn_count, @name, @label, @notes,
        @provenance, @source_tool
      )
      ON CONFLICT (binary_id, rva) DO UPDATE SET
        size        = excluded.size,
        insn_count  = excluded.insn_count,
        name        = COALESCE(excluded.name, "function".name),
        label       = COALESCE(excluded.label, "function".label),
        notes       = excluded.notes,
        provenance  = excluded.provenance,
        source_tool = excluded.source_tool
      RETURNING id
    `);
        const row = stmt.get({
            binary_id: input.binary_id,
            rva: input.rva,
            size: input.size,
            insn_count: input.insn_count,
            name: input.name,
            label: input.label,
            notes: input.notes,
            provenance: input.provenance,
            source_tool: input.source_tool,
        });
        if (!row) {
            throw new Error('addFunction: INSERT ... RETURNING id produced no row');
        }
        return row.id;
    }
    /**
     * Insert-or-update a cross-reference, keyed by (binary_id, from_rva, to_rva,
     * kind). Idempotent (A6). Returns the xref id.
     */
    addXref(input) {
        const stmt = this.db.prepare(`
      INSERT INTO xref (
        binary_id, from_rva, to_rva, kind, mnemonic, notes,
        provenance, source_tool
      ) VALUES (
        @binary_id, @from_rva, @to_rva, @kind, @mnemonic, @notes,
        @provenance, @source_tool
      )
      ON CONFLICT (binary_id, from_rva, to_rva, kind) DO UPDATE SET
        mnemonic    = excluded.mnemonic,
        notes       = excluded.notes,
        provenance  = excluded.provenance,
        source_tool = excluded.source_tool
      RETURNING id
    `);
        const row = stmt.get({
            binary_id: input.binary_id,
            from_rva: input.from_rva,
            to_rva: input.to_rva,
            kind: input.kind,
            mnemonic: input.mnemonic,
            notes: input.notes,
            provenance: input.provenance,
            source_tool: input.source_tool,
        });
        if (!row) {
            throw new Error('addXref: INSERT ... RETURNING id produced no row');
        }
        return row.id;
    }
    /**
     * Insert-or-update a symbol, keyed by (binary_id, rva, kind). Idempotent (A6).
     * Returns the symbol id.
     */
    addSymbol(input) {
        const stmt = this.db.prepare(`
      INSERT INTO symbol (
        binary_id, rva, name, kind, notes, provenance, source_tool
      ) VALUES (
        @binary_id, @rva, @name, @kind, @notes, @provenance, @source_tool
      )
      ON CONFLICT (binary_id, rva, kind) DO UPDATE SET
        name        = excluded.name,
        notes       = excluded.notes,
        provenance  = excluded.provenance,
        source_tool = excluded.source_tool
      RETURNING id
    `);
        const row = stmt.get({
            binary_id: input.binary_id,
            rva: input.rva,
            name: input.name,
            kind: input.kind,
            notes: input.notes,
            provenance: input.provenance,
            source_tool: input.source_tool,
        });
        if (!row) {
            throw new Error('addSymbol: INSERT ... RETURNING id produced no row');
        }
        return row.id;
    }
    /**
     * Run many writes inside one transaction. Returns the callback's result.
     * Far faster for a full-install walk, and atomic: a crash mid-walk leaves
     * the DB at its prior consistent state rather than half-populated.
     */
    transaction(fn) {
        const wrapped = this.db.transaction(fn);
        return wrapped();
    }
    /** Row counts per table — for the unpack summary / verifier / tests. */
    counts() {
        // `table` is a trusted literal from this method only (never user input).
        // "function" is a SQL keyword, so callers pass the already-quoted identifier.
        const one = (table) => {
            const row = this.db
                .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
                .get();
            return row.n;
        };
        return {
            game: one('game'),
            binary: one('binary'),
            asset: one('asset'),
            data_store: one('data_store'),
            function: one('"function"'),
            xref: one('xref'),
            symbol: one('symbol'),
        };
    }
    /** Row counts scoped to a single game_id. Convenience for per-game summaries. */
    countsForGame(gameId) {
        const one = (table) => {
            const row = this.db
                .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE game_id = ?`)
                .get(gameId);
            return row.n;
        };
        // Native tables (v2) key on binary_id, so scope them through binary(game_id).
        const viaBinary = (table) => {
            const row = this.db
                .prepare(`SELECT COUNT(*) AS n FROM ${table} t
           JOIN binary b ON b.id = t.binary_id
           WHERE b.game_id = ?`)
                .get(gameId);
            return row.n;
        };
        return {
            // The game table is keyed on id, not game_id.
            game: this.db.prepare('SELECT COUNT(*) AS n FROM game WHERE id = ?').get(gameId).n,
            binary: one('binary'),
            asset: one('asset'),
            data_store: one('data_store'),
            function: viaBinary('"function"'),
            xref: viaBinary('xref'),
            symbol: viaBinary('symbol'),
        };
    }
    /** Escape hatch for verifiers/tests that need a raw read. Read-only by convention. */
    raw() {
        return this.db;
    }
    /** Flush WAL back into the main DB and close the handle. */
    close() {
        try {
            this.db.pragma('wal_checkpoint(TRUNCATE)');
        }
        catch {
            // Best-effort checkpoint; closing is what matters.
        }
        this.db.close();
    }
}
//# sourceMappingURL=model-db.js.map
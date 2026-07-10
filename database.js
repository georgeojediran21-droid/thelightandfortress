const fs = require("fs");
const path = require("path");

const EMPTY_DB = { members: [], sessions: {}, updates: [], notifications: [], uploads: [], passwordResets: {} };

function normalizeDb(db) {
    return {
        members: Array.isArray(db.members) ? db.members : [],
        sessions: db.sessions && typeof db.sessions === "object" ? db.sessions : {},
        updates: Array.isArray(db.updates) ? db.updates : [],
        notifications: Array.isArray(db.notifications) ? db.notifications : [],
        uploads: Array.isArray(db.uploads) ? db.uploads : [],
        passwordResets: db.passwordResets && typeof db.passwordResets === "object" ? db.passwordResets : {}
    };
}

class JsonStore {
    constructor(dataDir, jsonFile) {
        this.dataDir = dataDir;
        this.jsonFile = jsonFile;
        this.backend = "json";
    }

    ensureStorage() {
        if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
        if (!fs.existsSync(this.jsonFile)) fs.writeFileSync(this.jsonFile, JSON.stringify(EMPTY_DB, null, 2));
    }

    read() {
        this.ensureStorage();
        try {
            return normalizeDb(JSON.parse(fs.readFileSync(this.jsonFile, "utf8")));
        } catch (error) {
            const backupFile = `${this.jsonFile}.${Date.now()}.broken`;
            fs.copyFileSync(this.jsonFile, backupFile);
            this.write(EMPTY_DB);
            return normalizeDb(EMPTY_DB);
        }
    }

    write(db) {
        this.ensureStorage();
        fs.writeFileSync(this.jsonFile, JSON.stringify(normalizeDb(db), null, 2));
    }

    close() {}
}

class SqliteStore {
    constructor(dataDir, jsonFile) {
        const { DatabaseSync } = require("node:sqlite");
        this.dataDir = dataDir;
        this.jsonFile = jsonFile;
        this.sqliteFile = path.join(dataDir, "app.sqlite");
        this.backend = "sqlite";
        this.db = null;
        this.DatabaseSync = DatabaseSync;
    }

    ensureStorage() {
        if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
        if (!this.db) this.db = new this.DatabaseSync(this.sqliteFile);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS updates (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS password_resets (token TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        `);
        this.migrateJsonOnce();
    }

    migrateJsonOnce() {
        const migrated = this.db.prepare("SELECT value FROM meta WHERE key = ?").get("json_migrated");
        if (migrated) return;

        if (fs.existsSync(this.jsonFile)) {
            try {
                const db = normalizeDb(JSON.parse(fs.readFileSync(this.jsonFile, "utf8")));
                const hasData = db.members.length || Object.keys(db.sessions).length || db.updates.length || db.notifications.length || db.uploads.length;
                if (hasData) this.writeInitialized(db);
            } catch (error) {
                const backupFile = `${this.jsonFile}.${Date.now()}.broken`;
                fs.copyFileSync(this.jsonFile, backupFile);
            }
        }

        this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("json_migrated", "1");
    }

    readCollection(table) {
        return this.db.prepare(`SELECT data FROM ${table}`).all().map((row) => JSON.parse(row.data));
    }

    read() {
        this.ensureStorage();
        const sessions = {};
        this.db.prepare("SELECT token, data FROM sessions").all().forEach((row) => {
            sessions[row.token] = JSON.parse(row.data);
        });
        const passwordResets = {};
        this.db.prepare("SELECT token, data FROM password_resets").all().forEach((row) => {
            passwordResets[row.token] = JSON.parse(row.data);
        });

        return normalizeDb({
            members: this.readCollection("members"),
            sessions,
            updates: this.readCollection("updates").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
            notifications: this.readCollection("notifications").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
            uploads: this.readCollection("uploads").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
            passwordResets
        });
    }

    replaceCollection(table, rows) {
        const insert = this.db.prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?)`);
        this.db.prepare(`DELETE FROM ${table}`).run();
        rows.forEach((row) => {
            insert.run(row.id, JSON.stringify(row));
        });
    }

    writeInitialized(db) {
        const normalized = normalizeDb(db);
        this.db.exec("BEGIN");
        try {
            this.replaceCollection("members", normalized.members);
            this.replaceCollection("updates", normalized.updates);
            this.replaceCollection("notifications", normalized.notifications);
            this.replaceCollection("uploads", normalized.uploads);

            const insertSession = this.db.prepare("INSERT INTO sessions (token, data) VALUES (?, ?)");
            this.db.prepare("DELETE FROM sessions").run();
            Object.entries(normalized.sessions).forEach(([token, session]) => {
                insertSession.run(token, JSON.stringify(session));
            });

            const insertReset = this.db.prepare("INSERT INTO password_resets (token, data) VALUES (?, ?)");
            this.db.prepare("DELETE FROM password_resets").run();
            Object.entries(normalized.passwordResets).forEach(([token, reset]) => {
                insertReset.run(token, JSON.stringify(reset));
            });

            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    write(db) {
        this.ensureStorage();
        this.writeInitialized(db);
    }

    close() {
        if (!this.db) return;
        this.db.close();
        this.db = null;
    }
}

function initDatabase({ dataDir, jsonFile }) {
    if ((process.env.DB_BACKEND || "").toLowerCase() === "json") {
        return new JsonStore(dataDir, jsonFile);
    }

    try {
        return new SqliteStore(dataDir, jsonFile);
    } catch (error) {
        console.warn("SQLite is not available in this Node.js runtime. Falling back to JSON storage.");
        return new JsonStore(dataDir, jsonFile);
    }
}

module.exports = { initDatabase };

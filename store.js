"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { MongoClient } = require("mongodb");

function sqliteTimestamp() {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function normalizeUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        username_lower: user.username_lower || user.username.toLowerCase(),
        password_salt: user.password_salt,
        password_hash: user.password_hash,
        role: user.role,
        status: user.status || "active",
        google_sub: user.google_sub || null,
        email: user.email || null,
        email_lower: user.email_lower || (user.email ? user.email.toLowerCase() : null),
        created_at: user.created_at
    };
}

function normalizePaper(paper) {
    if (!paper) return null;
    return {
        ...paper,
        title_lower: paper.title_lower || paper.title.toLowerCase()
    };
}

class Store {
    constructor({ databasePath, mongoUri, mongoDatabase }) {
        this.databasePath = databasePath;
        this.mongoUri = mongoUri;
        this.mongoDatabase = mongoDatabase;
        this.sqlite = null;
        this.client = null;
        this.mongo = null;
        this.collections = null;
        this.storageDescription = "local SQLite";
        this.initialization = null;
    }

    async initialize() {
        if (!this.initialization) {
            this.initialization = (async () => {
                if (!this.mongoUri) {
                    this.openSqlite();
                    return;
                }

                this.client = new MongoClient(this.mongoUri, { serverSelectionTimeoutMS: 10000 });
                await this.client.connect();
                this.mongo = this.client.db(this.mongoDatabase);
                this.storageDescription = `MongoDB Atlas (${this.mongoDatabase})`;
                this.collections = {
                    users: this.mongo.collection("users"),
                    sessions: this.mongo.collection("sessions"),
                    papers: this.mongo.collection("papers"),
                    migrations: this.mongo.collection("_app_migrations"),
                    counters: this.mongo.collection("_app_counters")
                };
                await this.initializeMongo();
            })().catch(async (error) => {
                this.initialization = null;
                if (this.client) {
                    await this.client.close();
                    this.client = null;
                }
                this.mongo = null;
                this.collections = null;
                throw error;
            });
        }
        await this.initialization;
    }

    openSqlite() {
        if (this.sqlite) return;
        fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
        this.sqlite = new DatabaseSync(this.databasePath);
        this.initializeSqlite();
        this.storageDescription = this.databasePath;
    }

    initializeSqlite() {
        this.sqlite.exec(`
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('Student', 'Faculty', 'Admin')),
                status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'rejected')),
                google_sub TEXT,
                email TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL,
                idle_expires_at INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
            CREATE TABLE IF NOT EXISTS papers (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                author TEXT NOT NULL,
                year INTEGER NOT NULL,
                topic TEXT NOT NULL,
                course TEXT NOT NULL,
                department TEXT NOT NULL,
                abstract TEXT NOT NULL,
                original_file_name TEXT NOT NULL,
                stored_file_name TEXT NOT NULL,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS papers_year ON papers(year DESC);
        `);
        const userColumns = this.sqlite.prepare("PRAGMA table_info(users)").all();
        if (!userColumns.some((column) => column.name === "status")) {
            this.sqlite.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'rejected'))");
        }
        if (!userColumns.some((column) => column.name === "google_sub")) {
            this.sqlite.exec("ALTER TABLE users ADD COLUMN google_sub TEXT");
        }
        if (!userColumns.some((column) => column.name === "email")) {
            this.sqlite.exec("ALTER TABLE users ADD COLUMN email TEXT");
        }
        this.sqlite.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique
                ON users (google_sub) WHERE google_sub IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS users_google_email_unique
                ON users (email) WHERE email IS NOT NULL;
        `);
        const paperColumns = this.sqlite.prepare("PRAGMA table_info(papers)").all();
        if (!paperColumns.some((column) => column.name === "status")) {
            this.sqlite.exec("ALTER TABLE papers ADD COLUMN status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected'))");
        }
    }

    async initializeMongo() {
        const { users, sessions, papers, migrations, counters } = this.collections;
        await users.createIndex({ id: 1 }, { unique: true });
        await users.createIndex({ username_lower: 1 }, { unique: true });
        await users.createIndex(
            { google_sub: 1 },
            { unique: true, partialFilterExpression: { google_sub: { $type: "string" } } }
        );
        await users.createIndex(
            { email_lower: 1 },
            { unique: true, partialFilterExpression: { email_lower: { $type: "string" } } }
        );
        await sessions.createIndex({ token_hash: 1 }, { unique: true });
        await sessions.createIndex({ expires_at: 1 });
        await papers.createIndex({ id: 1 }, { unique: true });
        await papers.createIndex({ year: -1, title_lower: 1 });
        await papers.createIndex({ status: 1, created_at: 1 });
        await papers.createIndex({ created_by: 1, created_at: -1 });

        let migration = await migrations.findOne({ _id: "sqlite-import-v1" });
        if (migration && migration.status === "completed") return;
        if (!migration) {
            const [userCount, sessionCount, paperCount] = await Promise.all([
                users.countDocuments(),
                sessions.countDocuments(),
                papers.countDocuments()
            ]);
            if (userCount + sessionCount + paperCount > 0) {
                throw new Error(
                    "The Atlas database already contains app data but has no completed SQLite import marker. " +
                    "No data was changed; use a new empty Atlas database or review the existing database first."
                );
            }
            try {
                await migrations.insertOne({
                    _id: "sqlite-import-v1",
                    status: "importing",
                    started_at: sqliteTimestamp()
                });
            } catch (error) {
                if (error.code !== 11000) throw error;
                migration = await migrations.findOne({ _id: "sqlite-import-v1" });
            }
        }
        if (!migration) migration = await migrations.findOne({ _id: "sqlite-import-v1" });
        if (migration && migration.status === "completed") return;
        if (!migration || migration.status !== "importing") {
            throw new Error("Atlas data import is in an unexpected state. No collection data was changed.");
        }

        const sourceExists = fs.existsSync(this.databasePath);
        if (sourceExists) this.openSqlite();
        const sqliteUsers = sourceExists
            ? this.sqlite.prepare("SELECT * FROM users ORDER BY id").all().map(normalizeUser)
            : [];
        const sqliteSessions = sourceExists ? this.sqlite.prepare("SELECT * FROM sessions").all() : [];
        const sqlitePapers = sourceExists
            ? this.sqlite.prepare("SELECT * FROM papers").all().map(normalizePaper)
            : [];

        try {
            if (sqliteUsers.length) {
                await users.bulkWrite(sqliteUsers.map((user) => ({
                    updateOne: { filter: { id: user.id }, update: { $setOnInsert: user }, upsert: true }
                })), { ordered: true });
            }
            if (sqliteSessions.length) {
                await sessions.bulkWrite(sqliteSessions.map((session) => ({
                    updateOne: {
                        filter: { token_hash: session.token_hash },
                        update: { $setOnInsert: session },
                        upsert: true
                    }
                })), { ordered: true });
            }
            if (sqlitePapers.length) {
                await papers.bulkWrite(sqlitePapers.map((paper) => ({
                    updateOne: { filter: { id: paper.id }, update: { $setOnInsert: paper }, upsert: true }
                })), { ordered: true });
            }
            const maxUserId = sqliteUsers.reduce((maximum, user) => Math.max(maximum, user.id), 0);
            await counters.updateOne(
                { _id: "users" },
                { $max: { value: maxUserId } },
                { upsert: true }
            );
            await migrations.updateOne(
                { _id: "sqlite-import-v1" },
                {
                    $set: {
                        status: "completed",
                        completed_at: sqliteTimestamp(),
                        counts: {
                            users: sqliteUsers.length,
                            sessions: sqliteSessions.length,
                            papers: sqlitePapers.length
                        }
                    }
                }
            );
            console.log(
                `Imported local SQLite data into Atlas (${sqliteUsers.length} users, ` +
                `${sqlitePapers.length} papers). Uploaded documents remain in the local data folder.`
            );
        } catch (error) {
            await migrations.updateOne(
                { _id: "sqlite-import-v1" },
                { $set: { status: "importing", last_error_at: sqliteTimestamp() } }
            );
            throw new Error(`SQLite data import into Atlas did not complete: ${error.message}`);
        }
    }

    get usesMongo() {
        return Boolean(this.mongo);
    }

    async close() {
        if (this.client) await this.client.close();
        if (this.sqlite) this.sqlite.close();
    }

    async userCount() {
        if (this.mongo) return this.collections.users.countDocuments();
        return this.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    }

    async adminCount() {
        if (this.mongo) return this.collections.users.countDocuments({ role: "Admin" });
        return this.sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'Admin'").get().count;
    }

    async getUserById(id) {
        const numericId = Number(id);
        if (this.mongo) return this.collections.users.findOne({ id: numericId });
        return this.sqlite.prepare("SELECT * FROM users WHERE id = ?").get(numericId) || null;
    }

    async getPublicUserById(id) {
        const numericId = Number(id);
        if (this.mongo) {
            return this.collections.users.findOne(
                { id: numericId },
                { projection: { id: 1, username: 1, role: 1, status: 1, created_at: 1 } }
            );
        }
        return this.sqlite.prepare("SELECT id, username, role, status, created_at FROM users WHERE id = ?").get(numericId) || null;
    }

    async getUserByUsername(username) {
        if (this.mongo) return this.collections.users.findOne({ username_lower: username.toLowerCase() });
        return this.sqlite.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) || null;
    }

    async getActiveUserByUsername(username) {
        if (this.mongo) return this.collections.users.findOne({ username_lower: username.toLowerCase(), status: { $in: ["active", "Admin"] } });
        return this.sqlite.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE AND status = 'active'").get(username) || null;
    }

    async getUserByGoogleSub(sub) {
        if (this.mongo) {
            return this.collections.users.findOne(
                { google_sub: sub },
                { projection: { id: 1, username: 1, role: 1, status: 1, created_at: 1 } }
            );
        }
        return this.sqlite.prepare(`
            SELECT id, username, role, status, created_at FROM users WHERE google_sub = ?
        `).get(sub) || null;
    }

    async getUserIdByEmail(email) {
        if (this.mongo) {
            const user = await this.collections.users.findOne(
                { email_lower: email.toLowerCase() },
                { projection: { id: 1 } }
            );
            return user || null;
        }
        return this.sqlite.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email) || null;
    }

    async createUser(userData) {
        if (this.mongo) {
            const result = await this.collections.counters.findOneAndUpdate(
                { _id: "users" },
                { $inc: { value: 1 } },
                { upsert: true, returnDocument: "after", includeResultMetadata: true }
            );
            const user = normalizeUser({
                ...userData,
                id: result.value,
                status: userData.status || "active",
                created_at: sqliteTimestamp()
            });
            try {
                await this.collections.users.insertOne(user);
                return user;
            } catch (error) {
                if (error.code === 11000) throw new Error("UNIQUE constraint failed: users.username");
                throw error;
            }
        }
        const result = this.sqlite.prepare(`
            INSERT INTO users (username, password_salt, password_hash, role, status, google_sub, email)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(userData.username, userData.password_salt, userData.password_hash, userData.role,
            userData.status || "active", userData.google_sub || null, userData.email || null);
        return this.getPublicUserById(result.lastInsertRowid);
    }

    async updateUser(id, changes) {
        const numericId = Number(id);
        if (this.mongo) {
            const set = {};
            for (const key of ["username", "role", "status", "password_salt", "password_hash", "email", "google_sub"]) {
                if (Object.prototype.hasOwnProperty.call(changes, key)) set[key] = changes[key];
            }
            if (changes.username !== undefined) set.username_lower = changes.username.toLowerCase();
            if (changes.email !== undefined) set.email_lower = changes.email ? changes.email.toLowerCase() : null;
            try {
                await this.collections.users.updateOne({ id: numericId }, { $set: set });
            } catch (error) {
                if (error.code === 11000) throw new Error("UNIQUE constraint failed: users.username");
                throw error;
            }
            return this.getPublicUserById(numericId);
        }
        if (Object.prototype.hasOwnProperty.call(changes, "password_salt")) {
            this.sqlite.prepare(`
                UPDATE users SET username = ?, role = ?, status = ?, password_salt = ?, password_hash = ? WHERE id = ?
            `).run(changes.username, changes.role, changes.status, changes.password_salt, changes.password_hash, numericId);
        } else if (Object.prototype.hasOwnProperty.call(changes, "email")) {
            this.sqlite.prepare("UPDATE users SET username = ?, role = ?, status = ?, email = ? WHERE id = ?").run(changes.username, changes.role, changes.status, changes.email, numericId);
        } else if (Object.prototype.hasOwnProperty.call(changes, "status")) {
            this.sqlite.prepare("UPDATE users SET username = ?, role = ?, status = ? WHERE id = ?").run(changes.username, changes.role, changes.status, numericId);
        } else {
            this.sqlite.prepare("UPDATE users SET username = ?, role = ? WHERE id = ?")
                .run(changes.username, changes.role, numericId);
        }
        return this.getPublicUserById(numericId);
    }

    async listUsers() {
        if (this.mongo) {
            return this.collections.users.find({}, {
                projection: { id: 1, username: 1, role: 1, status: 1, created_at: 1 }
            }).sort({ username_lower: 1 }).toArray();
        }
        return this.sqlite.prepare(`
            SELECT id, username, role, status, created_at FROM users ORDER BY username COLLATE NOCASE
        `).all();
    }

    async deleteUser(id) {
        const numericId = Number(id);
        if (this.mongo) {
            await Promise.all([
                this.collections.sessions.deleteMany({ user_id: numericId }),
                this.collections.papers.updateMany({ created_by: numericId }, { $set: { created_by: null } })
            ]);
            await this.collections.users.deleteOne({ id: numericId });
            return;
        }
        this.sqlite.prepare("DELETE FROM users WHERE id = ?").run(numericId);
    }

    async getSessionWithUser(tokenHash) {
        if (this.mongo) {
            const session = await this.collections.sessions.findOne({ token_hash: tokenHash });
            if (!session) return null;
            const user = await this.collections.users.findOne(
                { id: session.user_id },
                { projection: { id: 1, username: 1, role: 1, status: 1, created_at: 1 } }
            );
            return user ? { ...user, expires_at: session.expires_at, idle_expires_at: session.idle_expires_at } : null;
        }
        return this.sqlite.prepare(`
            SELECT users.id, users.username, users.role, users.status, users.created_at,
                   sessions.expires_at, sessions.idle_expires_at
            FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ?
        `).get(tokenHash) || null;
    }

    async saveSession(tokenHash, userId, expiresAt, idleExpiresAt) {
        if (this.mongo) {
            await this.collections.sessions.deleteMany({ expires_at: { $lte: Date.now() } });
            await this.collections.sessions.insertOne({
                token_hash: tokenHash,
                user_id: Number(userId),
                expires_at: expiresAt,
                idle_expires_at: idleExpiresAt,
                created_at: sqliteTimestamp()
            });
            return;
        }
        this.sqlite.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
        this.sqlite.prepare(`
            INSERT INTO sessions (token_hash, user_id, expires_at, idle_expires_at) VALUES (?, ?, ?, ?)
        `).run(tokenHash, userId, expiresAt, idleExpiresAt);
    }

    async touchSession(tokenHash, idleExpiresAt) {
        if (this.mongo) {
            await this.collections.sessions.updateOne({ token_hash: tokenHash }, { $set: { idle_expires_at: idleExpiresAt } });
            return;
        }
        this.sqlite.prepare("UPDATE sessions SET idle_expires_at = ? WHERE token_hash = ?")
            .run(idleExpiresAt, tokenHash);
    }

    async deleteSession(tokenHash) {
        if (this.mongo) {
            await this.collections.sessions.deleteOne({ token_hash: tokenHash });
            return;
        }
        this.sqlite.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    }

    async listApprovedPapers() {
        if (this.mongo) {
            return this.collections.papers.find(
                { status: "approved" },
                { projection: { _id: 0, id: 1, title: 1, author: 1, year: 1, topic: 1, course: 1, department: 1,
                    abstract: 1, original_file_name: 1, created_at: 1, updated_at: 1 } }
            ).sort({ year: -1, title_lower: 1 }).toArray();
        }
        return this.sqlite.prepare(`
            SELECT id, title, author, year, topic, course, department, abstract,
                   original_file_name AS fileName, created_at AS createdAt, updated_at AS updatedAt
            FROM papers WHERE status = 'approved' ORDER BY year DESC, title COLLATE NOCASE
        `).all();
    }

    async listSubmissions(userId) {
        if (this.mongo) {
            return this.collections.papers.find(
                { created_by: Number(userId) },
                { projection: { _id: 0, id: 1, title: 1, author: 1, year: 1, topic: 1, course: 1, department: 1,
                    abstract: 1, original_file_name: 1, status: 1, created_at: 1 } }
            ).sort({ created_at: -1 }).toArray();
        }
        return this.sqlite.prepare(`
            SELECT id, title, author, year, topic, course, department, abstract,
                   original_file_name AS fileName, status, created_at AS createdAt
            FROM papers WHERE created_by = ? ORDER BY created_at DESC
        `).all(userId);
    }

    async listPendingPapers() {
        if (this.mongo) {
            const pending = await this.collections.papers.find({ status: "pending" })
                .sort({ created_at: 1 }).toArray();
            const submitterIds = [...new Set(pending.map((paper) => paper.created_by).filter((id) => id !== null))];
            const users = submitterIds.length
                ? await this.collections.users.find({ id: { $in: submitterIds } }, { projection: { id: 1, username: 1 } }).toArray()
                : [];
            const usernames = new Map(users.map((user) => [user.id, user.username]));
            return pending.map((paper) => ({
                id: paper.id,
                title: paper.title,
                author: paper.author,
                year: paper.year,
                topic: paper.topic,
                course: paper.course,
                department: paper.department,
                abstract: paper.abstract,
                fileName: paper.original_file_name,
                createdAt: paper.created_at,
                submittedBy: usernames.get(paper.created_by) || null
            }));
        }
        return this.sqlite.prepare(`
            SELECT papers.id, papers.title, papers.author, papers.year, papers.topic,
                   papers.course, papers.department, papers.abstract,
                   papers.original_file_name AS fileName, papers.created_at AS createdAt,
                   users.username AS submittedBy
            FROM papers LEFT JOIN users ON users.id = papers.created_by
            WHERE papers.status = 'pending' ORDER BY papers.created_at ASC
        `).all();
    }

    async insertPaper(paper) {
        if (this.mongo) {
            const timestamp = sqliteTimestamp();
            await this.collections.papers.insertOne(normalizePaper({
                ...paper,
                created_at: timestamp,
                updated_at: timestamp
            }));
            return;
        }
        this.sqlite.prepare(`
            INSERT INTO papers (
                id, title, author, year, topic, course, department, abstract,
                original_file_name, stored_file_name, created_by, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(paper.id, paper.title, paper.author, paper.year, paper.topic, paper.course,
            paper.department, paper.abstract, paper.original_file_name, paper.stored_file_name,
            paper.created_by, paper.status);
    }

    async getPaper(id) {
        if (this.mongo) return this.collections.papers.findOne({ id });
        return this.sqlite.prepare("SELECT * FROM papers WHERE id = ?").get(id) || null;
    }

    async getPaperFile(id, status) {
        if (this.mongo) {
            return this.collections.papers.findOne(
                { id, status },
                { projection: { original_file_name: 1, stored_file_name: 1, status: 1 } }
            );
        }
        return this.sqlite.prepare(`
            SELECT original_file_name, stored_file_name, status FROM papers WHERE id = ? AND status = ?
        `).get(id, status) || null;
    }

    async updatePaper(id, changes) {
        if (this.mongo) {
            const set = { ...changes, updated_at: changes.updated_at || sqliteTimestamp() };
            if (changes.title !== undefined) set.title_lower = changes.title.toLowerCase();
            await this.collections.papers.updateOne({ id }, { $set: set });
            return;
        }
        if (Object.prototype.hasOwnProperty.call(changes, "status")) {
            this.sqlite.prepare(`
                UPDATE papers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
            `).run(changes.status, id);
        } else {
            this.sqlite.prepare(`
                UPDATE papers SET title = ?, author = ?, year = ?, topic = ?, course = ?,
                    department = ?, abstract = ?, original_file_name = ?, stored_file_name = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(changes.title, changes.author, changes.year, changes.topic, changes.course,
                changes.department, changes.abstract, changes.original_file_name, changes.stored_file_name, id);
        }
    }

    async rejectPaper(id) {
        if (this.mongo) {
            await this.collections.papers.updateOne(
                { id },
                { $set: { status: "rejected", stored_file_name: "", updated_at: sqliteTimestamp() } }
            );
            return;
        }
        this.sqlite.prepare(`
            UPDATE papers SET status = 'rejected', stored_file_name = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(id);
    }

    async deletePaper(id) {
        if (this.mongo) {
            await this.collections.papers.deleteOne({ id });
            return;
        }
        this.sqlite.prepare("DELETE FROM papers WHERE id = ?").run(id);
    }
}

function createStore(options) {
    if (options.databaseUrl) {
        return require("./postgres-store").createPostgresStore(options.databaseUrl);
    }
    return new Store(options);
}

module.exports = { createStore };

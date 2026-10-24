"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { MongoClient } = require("mongodb");
const { HeadObjectCommand, PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { FILE_TYPES } = require("../file-store");
const { createStore } = require("../store");

const mongoUri = process.env.MONGODB_URI;
const mongoDatabase = process.env.MONGODB_DATABASE || "sti_research_hub";
const databaseUrl = process.env.DATABASE_URL;
const r2AccountId = process.env.R2_ACCOUNT_ID;
const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const r2Bucket = process.env.R2_BUCKET_NAME;
const uploadsDirectory = path.join(__dirname, "..", "data", "uploads");
const maxFileBytes = 10 * 1024 * 1024;
const migrationId = "atlas-to-neon-v1";

async function objectExists(client, bucket, key) {
    try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch (error) {
        if (error.name === "NotFound" || error.$metadata && error.$metadata.httpStatusCode === 404) return false;
        throw error;
    }
}

function localFileHeaderIsValid(filePath, extension) {
    const buffer = Buffer.alloc(8);
    const descriptor = fs.openSync(filePath, "r");
    let bytesRead;
    try {
        bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    } finally {
        fs.closeSync(descriptor);
    }
    const header = buffer.subarray(0, bytesRead);
    if (extension === ".pdf") return header.subarray(0, 5).toString("ascii") === "%PDF-";
    if (extension === ".docx") return header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;
    return !header.includes(0);
}

async function uploadExistingDocuments(s3, bucket, papers) {
    for (const paper of papers) {
        if (!paper.stored_file_name || paper.status === "rejected") continue;
        if (paper.stored_file_name.startsWith("papers/") &&
            await objectExists(s3, bucket, paper.stored_file_name)) {
            continue;
        }

        const sourcePath = path.join(uploadsDirectory, path.basename(paper.stored_file_name));
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`The existing local document for paper ${paper.id} is missing.`);
        }
        const stats = fs.statSync(sourcePath);
        if (!stats.isFile() || stats.size <= 0 || stats.size > maxFileBytes) {
            throw new Error(`The existing document for paper ${paper.id} is empty or exceeds 10 MB.`);
        }
        const extension = path.extname(paper.original_file_name).toLocaleLowerCase();
        const contentType = FILE_TYPES.get(extension);
        if (!contentType) throw new Error(`Paper ${paper.id} has an unsupported document type.`);
        if (!localFileHeaderIsValid(sourcePath, extension)) {
            throw new Error(`The existing document for paper ${paper.id} does not match its file type.`);
        }

        const key = `papers/migrated/${paper.id}/${path.basename(paper.stored_file_name)}`;
        if (!await objectExists(s3, bucket, key)) {
            await s3.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: fs.createReadStream(sourcePath),
                ContentLength: stats.size,
                ContentType: contentType
            }));
        }
        paper.stored_file_name = key;
        console.log(`Copied existing document for paper ${paper.id} to private storage.`);
    }
}

async function main() {
    const required = [mongoUri, databaseUrl, r2AccountId, r2AccessKeyId, r2SecretAccessKey, r2Bucket];
    if (required.some((value) => !value)) {
        throw new Error("Set MONGODB_URI, DATABASE_URL, and all four R2 settings in the local .env file first.");
    }

    const atlas = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10000 });
    const target = createStore({ databaseUrl });
    const s3 = new S3Client({
        region: "auto",
        endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey }
    });

    try {
        await target.initialize();
        const [migration] = await target.sql`SELECT status FROM app_migrations WHERE id = ${migrationId}`;
        if (migration && migration.status === "completed") {
            console.log("Atlas-to-Neon migration is already complete; no data was changed.");
            return;
        }
        if (!migration) {
            const [usersCount] = await target.sql`SELECT COUNT(*)::INTEGER AS count FROM users`;
            const [sessionsCount] = await target.sql`SELECT COUNT(*)::INTEGER AS count FROM sessions`;
            const [papersCount] = await target.sql`SELECT COUNT(*)::INTEGER AS count FROM papers`;
            if (usersCount.count + sessionsCount.count + papersCount.count > 0) {
                throw new Error("The Neon database already contains app data. No migration was started.");
            }
            await target.sql`
                INSERT INTO app_migrations (id, status) VALUES (${migrationId}, 'importing')
                ON CONFLICT (id) DO NOTHING
            `;
        } else if (migration.status !== "importing") {
            throw new Error("The Neon migration marker is in an unexpected state; no data was changed.");
        }

        await atlas.connect();
        const source = atlas.db(mongoDatabase);
        const [users, sessions, papers] = await Promise.all([
            source.collection("users").find({}).toArray(),
            source.collection("sessions").find({}).toArray(),
            source.collection("papers").find({}).toArray()
        ]);

        await uploadExistingDocuments(s3, r2Bucket, papers);

        for (const user of users) {
            await target.sql`
                INSERT INTO users (
                    id, username, username_lower, password_salt, password_hash, role,
                    google_sub, email, email_lower, created_at
                ) VALUES (
                    ${Number(user.id)}, ${user.username}, ${user.username.toLowerCase()},
                    ${user.password_salt}, ${user.password_hash}, ${user.role},
                    ${user.google_sub || null}, ${user.email || null},
                    ${user.email ? user.email.toLowerCase() : null},
                    ${user.created_at || "1970-01-01 00:00:00"}
                )
                ON CONFLICT (id) DO NOTHING
            `;
        }
        for (const session of sessions) {
            await target.sql`
                INSERT INTO sessions (token_hash, user_id, expires_at, idle_expires_at, created_at)
                VALUES (
                    ${session.token_hash}, ${Number(session.user_id)}, ${Number(session.expires_at)},
                    ${Number(session.idle_expires_at)}, ${session.created_at || "1970-01-01 00:00:00"}
                )
                ON CONFLICT (token_hash) DO NOTHING
            `;
        }
        for (const paper of papers) {
            await target.sql`
                INSERT INTO papers (
                    id, title, title_lower, author, year, topic, course, department, abstract,
                    original_file_name, stored_file_name, created_by, status, created_at, updated_at
                ) VALUES (
                    ${paper.id}, ${paper.title}, ${paper.title.toLowerCase()}, ${paper.author},
                    ${paper.year}, ${paper.topic}, ${paper.course}, ${paper.department}, ${paper.abstract},
                    ${paper.original_file_name}, ${paper.stored_file_name || ""},
                    ${paper.created_by === null || paper.created_by === undefined ? null : Number(paper.created_by)},
                    ${paper.status || "approved"}, ${paper.created_at || "1970-01-01 00:00:00"},
                    ${paper.updated_at || paper.created_at || "1970-01-01 00:00:00"}
                )
                ON CONFLICT (id) DO NOTHING
            `;
        }
        await target.sql`
            SELECT setval(
                pg_get_serial_sequence('users', 'id'),
                GREATEST(COALESCE((SELECT MAX(id) FROM users), 1), 1),
                EXISTS (SELECT 1 FROM users)
            )
        `;
        await target.sql`
            UPDATE app_migrations SET status = 'completed',
                updated_at = to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')
            WHERE id = ${migrationId}
        `;
        console.log(`Migration complete: ${users.length} users, ${sessions.length} sessions, ${papers.length} papers.`);
    } finally {
        await Promise.all([atlas.close(), target.close(), s3.destroy()]);
    }
}

main().catch((error) => {
    console.error(`Atlas-to-Neon migration failed: ${error.message}`);
    process.exitCode = 1;
});

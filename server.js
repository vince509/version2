"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { promisify } = require("node:util");
const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const multer = require("multer");
const { createStore } = require("./store");
const { createFileStore, FILE_TYPES, FileStoreError } = require("./file-store");

const app = express();
const IS_VERCEL = process.env.VERCEL === "1";
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const VERCEL_PRODUCTION_HOST = process.env.VERCEL_PROJECT_PRODUCTION_URL || "";
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN ||
    (IS_VERCEL && VERCEL_PRODUCTION_HOST ? `https://${VERCEL_PRODUCTION_HOST}` : "")).replace(/\/+$/, "");
let publicUrl = null;
if (PUBLIC_ORIGIN) {
    try {
        publicUrl = new URL(PUBLIC_ORIGIN);
    } catch {
        throw new Error("PUBLIC_ORIGIN must be a valid HTTPS origin.");
    }
    if (publicUrl.protocol !== "https:" || publicUrl.pathname !== "/" ||
        publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
        throw new Error("PUBLIC_ORIGIN must be an HTTPS origin without a path, query, or credentials.");
    }
}
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const ALLOW_PASSWORD_SIGNUP = process.env.ALLOW_PASSWORD_SIGNUP !== "false";
if (Boolean(GOOGLE_CLIENT_ID) !== Boolean(GOOGLE_CLIENT_SECRET)) {
    throw new Error("Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Google sign-in.");
}
if (GOOGLE_CLIENT_ID && !publicUrl) {
    throw new Error("Set PUBLIC_ORIGIN to the app's HTTPS production origin before enabling Google sign-in.");
}
if (IS_VERCEL && !publicUrl) {
    throw new Error("Set PUBLIC_ORIGIN to the app's HTTPS production URL in Vercel project settings.");
}
const googleOAuth = GOOGLE_CLIENT_ID
    ? new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, `${PUBLIC_ORIGIN}/auth/google/callback`)
    : null;
const oauthStates = new Map();
const OAUTH_STATE_COOKIE = "sti_google_oauth_state";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
if (HOST !== "localhost" && HOST !== "127.0.0.1" &&
    (!net.isIPv4(HOST) || HOST === "0.0.0.0")) {
    throw new Error("HOST must be localhost, 127.0.0.1, or a specific IPv4 address such as this computer's Tailscale IP.");
}
const ALLOWED_HOSTS = new Set([HOST]);
if (HOST === "localhost" || HOST === "127.0.0.1") {
    ALLOWED_HOSTS.add("localhost");
    ALLOWED_HOSTS.add("127.0.0.1");
}
if (publicUrl) ALLOWED_HOSTS.add(publicUrl.hostname);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_PATH = path.join(DATA_DIR, "research.sqlite");
const PUBLIC_DIR = path.join(ROOT, "public");
const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DATABASE = process.env.MONGODB_DATABASE || "sti_research_hub";
const DATABASE_URL = process.env.DATABASE_URL || "";
const store = createStore({
    databasePath: DB_PATH,
    mongoUri: MONGODB_URI,
    mongoDatabase: MONGODB_DATABASE,
    databaseUrl: DATABASE_URL
});
const r2Values = {
    accountId: process.env.R2_ACCOUNT_ID || "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    bucket: process.env.R2_BUCKET_NAME || ""
};
const configuredR2Values = Object.values(r2Values).filter(Boolean).length;
if (configuredR2Values !== 0 && configuredR2Values !== Object.keys(r2Values).length) {
    throw new Error("Set all four R2 storage environment variables or leave all of them blank.");
}
if (IS_VERCEL && !DATABASE_URL) {
    throw new Error("Set DATABASE_URL to your Neon PostgreSQL connection string in Vercel project environment variables.");
}
if (IS_VERCEL && configuredR2Values !== Object.keys(r2Values).length) {
    throw new Error("Configure a private Cloudflare R2 bucket and all R2 environment variables before deploying.");
}
const fileStore = createFileStore({
    root: UPLOAD_DIR,
    maxFileBytes: MAX_FILE_BYTES,
    r2: configuredR2Values ? r2Values : null
});
const VERCEL_HOSTS = new Set([
    process.env.VERCEL_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL
].filter(Boolean).map((host) => host.replace(/^https?:\/\//, "").replace(/\/+$/, "")));
for (const host of VERCEL_HOSTS) ALLOWED_HOSTS.add(host);
const SESSION_COOKIE = "sti_research_session";
const SESSION_LENGTH = 12 * 60 * 60 * 1000;
const REMEMBERED_SESSION_LENGTH = 30 * 24 * 60 * 60 * 1000;
const IDLE_SESSION_LENGTH = 15 * 60 * 1000;
const ALLOWED_EXTENSIONS = new Set(FILE_TYPES.keys());
const scrypt = promisify(crypto.scrypt);
const authAttempts = new Map();

if (!fileStore.usesRemoteStorage) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.disable("x-powered-by");
app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (IS_VERCEL) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
    );

    const host = request.headers.host || "";
    const validHosts = [...ALLOWED_HOSTS].flatMap((allowedHost) =>
        allowedHost === publicUrl?.hostname
            ? [allowedHost, `${allowedHost}:443`]
            : VERCEL_HOSTS.has(allowedHost)
                ? [allowedHost]
            : [`${allowedHost}:${PORT}`]
    );
    if (!validHosts.includes(host) && !isPublicOriginRequest(request)) {
        response.status(403).send("This application only accepts connections through its configured local or private address.");
        return;
    }
    next();
});
app.use(async (_request, _response, next) => {
    try {
        await store.initialize();
        next();
    } catch (error) {
        next(error);
    }
});
app.use(express.json({ limit: "128kb", strict: true }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

function isPublicOriginRequest(request) {
    if (!publicUrl) return false;
    if (request.get("host") === publicUrl.host) return true;
    return request.get("x-forwarded-host") === publicUrl.host &&
        request.get("x-forwarded-proto") === "https";
}

const upload = multer({
    storage: fileStore.usesRemoteStorage
        ? multer.memoryStorage()
        : multer.diskStorage({
        destination: (_request, _file, callback) => callback(null, UPLOAD_DIR),
        filename: (_request, file, callback) => {
            const extension = path.extname(file.originalname).toLocaleLowerCase();
            callback(null, `${crypto.randomUUID()}${extension}`);
        }
    }),
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 12, fieldSize: 12000 },
    fileFilter: (_request, file, callback) => {
        const extension = path.extname(file.originalname).toLocaleLowerCase();
        if (!ALLOWED_EXTENSIONS.has(extension)) {
            callback(new HttpError(400, "Choose a PDF, DOCX, or TXT document."));
            return;
        }
        callback(null, true);
    }
});

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function cleanText(value, field, maxLength, required = true) {
    if (typeof value !== "string") {
        if (!required && (value === undefined || value === null)) {
            return "";
        }
        throw new HttpError(400, `${field} is required.`);
    }
    const text = value.trim();
    if ((!text && required) || text.length > maxLength) {
        throw new HttpError(400, text ? `${field} must be ${maxLength} characters or fewer.` : `${field} is required.`);
    }
    return text;
}

function publicUser(user) {
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.created_at
    };
}

function parseCookie(request, name) {
    const cookieHeader = request.headers.cookie || "";
    for (const item of cookieHeader.split(";")) {
        const separator = item.indexOf("=");
        if (separator < 0) continue;
        if (item.slice(0, separator).trim() === name) {
            return decodeURIComponent(item.slice(separator + 1).trim());
        }
    }
    return "";
}

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function secureCookie(response, token, maxAge) {
    const secure = publicUrl ? "; Secure" : "";
    response.setHeader("Set-Cookie",
        `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAge / 1000)}${secure}`);
}

function clearCookie(response) {
    const secure = publicUrl ? "; Secure" : "";
    response.setHeader("Set-Cookie",
        `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

function requireLocalOrigin(request, _response, next) {
    const origin = request.get("origin");
    if (!origin) {
        next();
        return;
    }
    let parsed;
    try {
        parsed = new URL(origin);
    } catch {
        next(new HttpError(403, "Invalid request origin."));
        return;
    }
    const localOrigin = ALLOWED_HOSTS.has(parsed.hostname) && parsed.port === String(PORT);
    const publicOrigin = Boolean(publicUrl && parsed.origin === PUBLIC_ORIGIN);
    const vercelOrigin = IS_VERCEL && parsed.protocol === "https:" && VERCEL_HOSTS.has(parsed.hostname);
    if (!localOrigin && !publicOrigin && !vercelOrigin) {
        next(new HttpError(403, "Requests must come from this local or private application address."));
        return;
    }
    next();
}

function rateLimitAuth(request, response, next) {
    const key = request.ip || request.socket.remoteAddress || "local";
    const now = Date.now();
    let attempt = authAttempts.get(key);
    if (!attempt || attempt.resetAt <= now) {
        attempt = { count: 0, resetAt: now + 15 * 60 * 1000 };
        authAttempts.set(key, attempt);
    }
    if (attempt.count >= 10) {
        response.status(429).json({ error: "Too many sign-in attempts. Wait 15 minutes and try again." });
        return;
    }
    attempt.count += 1;
    next();
}

async function requireAuth(request, _response, next) {
    const token = parseCookie(request, SESSION_COOKIE);
    if (!token) {
        next(new HttpError(401, "Please log in to continue."));
        return;
    }
    try {
        const tokenHash = hashToken(token);
        const session = await store.getSessionWithUser(tokenHash);
        if (!session || session.expires_at <= Date.now() || session.idle_expires_at <= Date.now()) {
            await store.deleteSession(tokenHash);
            next(new HttpError(401, "Your session expired. Please log in again."));
            return;
        }
        await store.touchSession(tokenHash, Date.now() + IDLE_SESSION_LENGTH);
        request.user = session;
        next();
    } catch (error) {
        next(error);
    }
}

function requireRole(...roles) {
    return (request, _response, next) => {
        if (!request.user || !roles.includes(request.user.role)) {
            next(new HttpError(403, "Your account does not have permission to do that."));
            return;
        }
        next();
    };
}

async function setPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const key = await scrypt(password, salt, 64);
    return { salt, hash: key.toString("hex") };
}

async function passwordMatches(password, salt, expectedHash) {
    const actual = await scrypt(password, salt, 64);
    const expected = Buffer.from(expectedHash, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function createSession(response, user, remember) {
    const token = crypto.randomBytes(32).toString("base64url");
    const duration = remember ? REMEMBERED_SESSION_LENGTH : SESSION_LENGTH;
    const now = Date.now();
    await store.saveSession(hashToken(token), user.id, now + duration, now + IDLE_SESSION_LENGTH);
    secureCookie(response, token, duration);
}

function enforceSameOrigin(request, response, next) {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
        requireLocalOrigin(request, response, next);
        return;
    }
    next();
}

app.use("/api", enforceSameOrigin);

app.get("/api/session", async (request, response, next) => {
    try {
        await new Promise((resolve, reject) => requireAuth(request, response, (error) => error ? reject(error) : resolve()));
        response.json({ user: publicUser(request.user), setupRequired: false });
    } catch (error) {
        if (error.status === 401) {
            try {
                response.json({
                    user: null,
                    setupRequired: !IS_VERCEL && await store.userCount() === 0
                });
            } catch (storeError) {
                next(storeError);
            }
            return;
        }
        next(error);
    }
});

app.post("/api/auth/register", rateLimitAuth, async (request, response, next) => {
    try {
        const username = cleanText(request.body.username, "Username", 32);
        const password = request.body.password;
        const accountCount = await store.userCount();
        const canSelfRegister = ALLOW_PASSWORD_SIGNUP || accountCount === 0;
        if (!canSelfRegister) {
            throw new HttpError(403, "Password sign-up is disabled. Ask an Admin to create your account.");
        }
        if (typeof password !== "string") throw new HttpError(400, "Password is required.");
        if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) {
            throw new HttpError(400, "Username must be 3–32 letters, numbers, dots, dashes, or underscores.");
        }
        if (password.length < 10) {
            throw new HttpError(400, "Choose a password with at least 10 characters.");
        }
        if (password.length > 200) {
            throw new HttpError(400, "Password must be 200 characters or fewer.");
        }

        const credentials = await setPassword(password);
        const role = accountCount === 0 ? "Admin" : "Student";
        let user;
        try {
            user = await store.createUser({
                username,
                password_salt: credentials.salt,
                password_hash: credentials.hash,
                role
            });
        } catch (error) {
            if (String(error.message).includes("UNIQUE")) {
                throw new HttpError(409, "That username is already registered.");
            }
            throw error;
        }
        await createSession(response, user, Boolean(request.body.remember));
        authAttempts.delete(request.ip || request.socket.remoteAddress || "local");
        response.status(201).json({ user: publicUser(user), firstAccount: accountCount === 0 });
    } catch (error) {
        next(error);
    }
});

app.post("/api/auth/login", rateLimitAuth, async (request, response, next) => {
    try {
        const username = cleanText(request.body.username, "Username", 32);
        const password = request.body.password;
        if (typeof password !== "string" || password.length > 200) {
            throw new HttpError(400, "Enter a valid password.");
        }
        const user = await store.getUserByUsername(username);
        const credentials = user || {
            password_salt: "00000000000000000000000000000000",
            password_hash: "0".repeat(128)
        };
        const matches = await passwordMatches(password, credentials.password_salt, credentials.password_hash);
        if (!user || !matches) {
            response.status(401).json({ error: "Incorrect username or password." });
            return;
        }
        await createSession(response, user, Boolean(request.body.remember));
        authAttempts.delete(request.ip || request.socket.remoteAddress || "local");
        response.json({ user: publicUser(user) });
    } catch (error) {
        next(error);
    }
});

app.get("/api/auth/config", async (request, response, next) => {
    try {
        response.json({
            googleEnabled: Boolean(googleOAuth && isPublicOriginRequest(request)),
            passwordSignupEnabled: ALLOW_PASSWORD_SIGNUP || (await store.userCount()) === 0,
            directUploads: fileStore.usesRemoteStorage
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/uploads/prepare", requireAuth, requireRole("Student", "Faculty", "Admin"), async (request, response, next) => {
    if (!fileStore.usesRemoteStorage) {
        next(new HttpError(404, "Direct cloud uploads are not enabled for this server."));
        return;
    }
    try {
        const fileName = cleanText(request.body.fileName, "File name", 255);
        const prepared = await fileStore.prepareUpload(request.user.id, fileName, request.body.size);
        response.json(prepared);
    } catch (error) {
        next(error);
    }
});

app.get("/auth/google", async (request, response) => {
    if (!googleOAuth) {
        response.redirect("/research.html?authError=google_not_configured");
        return;
    }
    if (!isPublicOriginRequest(request)) {
        response.redirect("/research.html?authError=google_public_url_required");
        return;
    }
    const now = Date.now();
    for (const [state, attempt] of oauthStates) {
        if (attempt.expiresAt <= now) oauthStates.delete(state);
    }
    const state = crypto.randomBytes(32).toString("base64url");
    if (oauthStates.size >= 1000) oauthStates.clear();
    const { codeVerifier, codeChallenge } = await googleOAuth.generateCodeVerifierAsync();
    oauthStates.set(state, { expiresAt: now + 10 * 60 * 1000, codeVerifier });
    const secure = publicUrl ? "; Secure" : "";
    response.setHeader("Set-Cookie",
        `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=600${secure}`);
    response.redirect(googleOAuth.generateAuthUrl({
        scope: ["openid", "email"],
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "select_account"
    }));
});

async function googleUsername(email) {
    let prefix = email.split("@")[0].toLocaleLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 20) || "student";
    if (prefix.length < 3) prefix = `student-${prefix}`;
    let username = prefix;
    while (await store.getUserByUsername(username)) {
        username = `${prefix.slice(0, 16)}-${crypto.randomBytes(3).toString("hex")}`;
    }
    return username;
}

app.get("/auth/google/callback", async (request, response, next) => {
    const state = typeof request.query.state === "string" ? request.query.state : "";
    const cookieState = parseCookie(request, OAUTH_STATE_COOKIE);
    const attempt = oauthStates.get(state);
    oauthStates.delete(state);
    const secure = publicUrl ? "; Secure" : "";
    response.setHeader("Set-Cookie",
        `${OAUTH_STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=0${secure}`);

    if (!googleOAuth) {
        response.redirect("/research.html?authError=google_not_configured");
        return;
    }
    if (!state || !cookieState || state !== cookieState || !attempt || attempt.expiresAt <= Date.now()) {
        response.redirect(`${PUBLIC_ORIGIN}/research.html?authError=google_state`);
        return;
    }
    if (request.query.error || typeof request.query.code !== "string") {
        response.redirect(`${PUBLIC_ORIGIN}/research.html?authError=google_cancelled`);
        return;
    }

    try {
        const { tokens } = await googleOAuth.getToken({
            code: request.query.code,
            redirect_uri: `${PUBLIC_ORIGIN}/auth/google/callback`,
            codeVerifier: attempt.codeVerifier
        });
        if (!tokens.id_token) throw new HttpError(401, "Google did not return a verified identity.");
        const ticket = await googleOAuth.verifyIdToken({
            idToken: tokens.id_token,
            audience: GOOGLE_CLIENT_ID
        });
        const identity = ticket.getPayload();
        if (!identity || !identity.sub || !identity.email || identity.email_verified !== true) {
            throw new HttpError(401, "Use a Google account with a verified email address.");
        }

        let user = await store.getUserByGoogleSub(identity.sub);
        if (!user) {
            if (IS_VERCEL) {
                response.redirect(`${PUBLIC_ORIGIN}/research.html?authError=google_account_not_invited`);
                return;
            }
            const emailOwner = await store.getUserIdByEmail(identity.email);
            if (emailOwner) {
                response.redirect(`${PUBLIC_ORIGIN}/research.html?authError=google_account_exists`);
                return;
            }
            const credentials = await setPassword(crypto.randomBytes(32).toString("hex"));
            const accountCount = await store.userCount();
            const username = await googleUsername(identity.email);
            user = await store.createUser({
                username,
                password_salt: credentials.salt,
                password_hash: credentials.hash,
                role: accountCount === 0 ? "Admin" : "Student",
                google_sub: identity.sub,
                email: identity.email
            });
        } else {
            await store.updateUser(user.id, { email: identity.email });
        }

        await createSession(response, user, false);
        response.redirect(`${PUBLIC_ORIGIN}/research.html?auth=google`);
    } catch (error) {
        console.error("Google sign-in failed:", error.message);
        response.redirect(`${PUBLIC_ORIGIN}/research.html?authError=google_failed`);
    }
});

app.post("/api/auth/logout", requireAuth, async (request, response, next) => {
    try {
        const token = parseCookie(request, SESSION_COOKIE);
        await store.deleteSession(hashToken(token));
        clearCookie(response);
        response.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.get("/api/papers", requireAuth, async (_request, response, next) => {
    try {
        const records = await store.listApprovedPapers();
        const papers = records.map((paper) => paper.fileName !== undefined ? paper : ({
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
            updatedAt: paper.updated_at
        }));
        response.json({ papers });
    } catch (error) {
        next(error);
    }
});

app.get("/api/my-submissions", requireAuth, async (request, response, next) => {
    try {
        const records = await store.listSubmissions(request.user.id);
        const submissions = records.map((paper) => paper.fileName !== undefined ? paper : ({
            id: paper.id,
            title: paper.title,
            author: paper.author,
            year: paper.year,
            topic: paper.topic,
            course: paper.course,
            department: paper.department,
            abstract: paper.abstract,
            fileName: paper.original_file_name,
            status: paper.status,
            createdAt: paper.created_at
        }));
        response.json({ submissions });
    } catch (error) {
        next(error);
    }
});

app.get("/api/papers/pending", requireAuth, requireRole("Admin"), async (_request, response, next) => {
    try {
        response.json({ papers: await store.listPendingPapers() });
    } catch (error) {
        next(error);
    }
});

function cleanPaper(body, file, existing = null) {
    const title = cleanText(body.title, "Title", 240);
    const author = cleanText(body.author, "Author", 200);
    const year = Number(body.year);
    if (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear() + 5) {
        throw new HttpError(400, "Enter a valid publication year.");
    }
    return {
        title,
        author,
        year,
        topic: cleanText(body.topic, "Topic", 120),
        course: cleanText(body.course, "Course", 120),
        department: cleanText(body.department, "Department", 160),
        abstract: cleanText(body.abstract, "Abstract", 10000),
        originalFileName: file ? path.basename(file.originalname).slice(0, 255) : existing && existing.original_file_name,
        storedFileName: file ? file.filename : existing && existing.stored_file_name
    };
}

function checkFileContent(file) {
    let header;
    if (file.buffer) {
        header = file.buffer.subarray(0, 8);
    } else {
        const handle = fs.openSync(file.path, "r");
        try {
            header = Buffer.alloc(8);
            const bytesRead = fs.readSync(handle, header, 0, header.length, 0);
            header = header.subarray(0, bytesRead);
        } finally {
            fs.closeSync(handle);
        }
    }
    const extension = path.extname(file.originalname).toLocaleLowerCase();
    if (extension === ".pdf" && header.subarray(0, Math.min(header.length, 5)).toString("ascii") !== "%PDF-") {
        throw new HttpError(400, "This file does not appear to be a valid PDF.");
    }
    if (extension === ".docx" &&
        !(header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04)) {
        throw new HttpError(400, "This file does not appear to be a valid DOCX document.");
    }
    if (extension === ".txt" && header.includes(0)) {
        throw new HttpError(400, "Text files must contain plain text.");
    }
}

async function removeUploadedFile(file) {
    if (file && file.key) {
        await fileStore.delete(file.key);
        return;
    }
    if (file && file.path) {
        try {
            await fs.promises.unlink(file.path);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
}

async function cleanupUploadedFile(file) {
    try {
        await removeUploadedFile(file);
    } catch (error) {
        console.error("Could not clean up an unsuccessful document upload:", error.message);
    }
}

async function removeStoredDocument(storedFileName) {
    if (!storedFileName) return;
    if (fileStore.usesRemoteStorage) {
        await fileStore.delete(storedFileName);
        return;
    }
    await removeUploadedFile({ path: path.join(UPLOAD_DIR, path.basename(storedFileName)) });
}

app.post("/api/papers", requireAuth, requireRole("Student", "Faculty", "Admin"), async (request, response, next) => {
    if (fileStore.usesRemoteStorage) {
        let uploadedKey = "";
        try {
            const fileName = cleanText(request.body.fileName, "File name", 255);
            uploadedKey = cleanText(request.body.objectKey, "Uploaded document");
            await fileStore.verifyUpload(uploadedKey, request.user.id);
            const paper = cleanPaper(request.body, { originalname: fileName, filename: uploadedKey });
            const id = crypto.randomUUID();
            const status = request.user.role === "Student" ? "pending" : "approved";
            await store.insertPaper({
                id,
                title: paper.title,
                title_lower: paper.title.toLowerCase(),
                author: paper.author,
                year: paper.year,
                topic: paper.topic,
                course: paper.course,
                department: paper.department,
                abstract: paper.abstract,
                original_file_name: paper.originalFileName,
                stored_file_name: paper.storedFileName,
                created_by: request.user.id,
                status
            });
            response.status(201).json({
                paper: { id, ...paper, fileName: paper.originalFileName },
                status
            });
        } catch (error) {
            if (uploadedKey) {
                try {
                    await removeUploadedFile({ key: uploadedKey });
                } catch (cleanupError) {
                    console.error("Could not remove an unsuccessful cloud upload:", cleanupError.message);
                }
            }
            next(error);
        }
        return;
    }

    upload.single("file")(request, response, async (uploadError) => {
        if (uploadError) {
            next(uploadError);
            return;
        }
        try {
            if (!request.file) {
                throw new HttpError(400, "Select a PDF, DOCX, or TXT research document.");
            }
            checkFileContent(request.file);
            const paper = cleanPaper(request.body, request.file);
            const id = crypto.randomUUID();
            const status = request.user.role === "Student" ? "pending" : "approved";
            await store.insertPaper({
                id,
                title: paper.title,
                title_lower: paper.title.toLowerCase(),
                author: paper.author,
                year: paper.year,
                topic: paper.topic,
                course: paper.course,
                department: paper.department,
                abstract: paper.abstract,
                original_file_name: paper.originalFileName,
                stored_file_name: paper.storedFileName,
                created_by: request.user.id,
                status
            });
            response.status(201).json({
                paper: { id, ...paper, fileName: paper.originalFileName },
                status
            });
        } catch (error) {
            await cleanupUploadedFile(request.file);
            next(error);
        }
    });
});

app.patch("/api/papers/:id/review", requireAuth, requireRole("Admin"), async (request, response, next) => {
    try {
        const status = request.body.status;
        if (!["approved", "rejected"].includes(status)) {
            throw new HttpError(400, "Choose whether to approve or reject this submission.");
        }
        const paper = await store.getPaper(request.params.id);
        if (!paper) throw new HttpError(404, "Submission not found.");
        if (paper.status !== "pending") throw new HttpError(409, "This submission has already been reviewed.");
        if (status === "approved") {
            await store.updatePaper(request.params.id, { status: "approved" });
        } else {
            await store.rejectPaper(request.params.id);
            await removeStoredDocument(paper.stored_file_name);
        }
        response.json({ success: true, status });
    } catch (error) {
        next(error);
    }
});

app.put("/api/papers/:id", requireAuth, requireRole("Faculty", "Admin"), (request, response, next) => {
    if (fileStore.usesRemoteStorage) {
        (async () => {
            let uploadedKey = "";
            try {
                const existing = await store.getPaper(request.params.id);
                if (!existing) throw new HttpError(404, "Paper not found.");
                let file = null;
                if (request.body.objectKey) {
                    uploadedKey = cleanText(request.body.objectKey, "Uploaded document");
                    const fileName = cleanText(request.body.fileName, "File name", 255);
                    await fileStore.verifyUpload(uploadedKey, request.user.id);
                    file = { originalname: fileName, filename: uploadedKey };
                }
                const paper = cleanPaper(request.body, file, existing);
                await store.updatePaper(existing.id, {
                    title: paper.title,
                    author: paper.author,
                    year: paper.year,
                    topic: paper.topic,
                    course: paper.course,
                    department: paper.department,
                    abstract: paper.abstract,
                    original_file_name: paper.originalFileName,
                    stored_file_name: paper.storedFileName
                });
                if (uploadedKey && existing.stored_file_name) {
                    await removeStoredDocument(existing.stored_file_name);
                }
                response.json({ paper: { id: existing.id, ...paper, fileName: paper.originalFileName } });
            } catch (error) {
                if (uploadedKey) {
                    try {
                        await removeUploadedFile({ key: uploadedKey });
                    } catch (cleanupError) {
                        console.error("Could not remove an unsuccessful cloud upload:", cleanupError.message);
                    }
                }
                next(error);
            }
        })();
        return;
    }
    upload.single("file")(request, response, async (uploadError) => {
        if (uploadError) {
            next(uploadError);
            return;
        }
        try {
            const existing = await store.getPaper(request.params.id);
            if (!existing) throw new HttpError(404, "Paper not found.");
            if (request.file) checkFileContent(request.file);
            const paper = cleanPaper(request.body, request.file, existing);
            await store.updatePaper(existing.id, {
                title: paper.title,
                author: paper.author,
                year: paper.year,
                topic: paper.topic,
                course: paper.course,
                department: paper.department,
                abstract: paper.abstract,
                original_file_name: paper.originalFileName,
                stored_file_name: paper.storedFileName
            });
            if (request.file && existing.stored_file_name) await removeStoredDocument(existing.stored_file_name);
            response.json({ paper: { id: existing.id, ...paper, fileName: paper.originalFileName } });
        } catch (error) {
            await cleanupUploadedFile(request.file);
            next(error);
        }
    });
});

app.delete("/api/papers/:id", requireAuth, requireRole("Faculty", "Admin"), async (request, response, next) => {
    try {
        const paper = await store.getPaper(request.params.id);
        if (!paper) throw new HttpError(404, "Paper not found.");
        await store.deletePaper(request.params.id);
        await removeStoredDocument(paper.stored_file_name);
        response.json({ success: true });
    } catch (error) {
        next(error);
    }
});

app.get("/api/papers/:id/review-download", requireAuth, requireRole("Admin"), async (request, response, next) => {
    try {
        const paper = await store.getPaperFile(request.params.id, "pending");
        if (!paper) {
            next(new HttpError(404, "Pending submission not found."));
            return;
        }
        if (fileStore.usesRemoteStorage) {
            await fileStore.download(paper.stored_file_name, paper.original_file_name, response, next);
            return;
        }
        const filePath = path.join(UPLOAD_DIR, path.basename(paper.stored_file_name));
        response.download(filePath, paper.original_file_name, (error) => {
            if (error && !response.headersSent) next(new HttpError(404, "The submitted document could not be found."));
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/papers/:id/download", requireAuth, async (request, response, next) => {
    try {
        const paper = await store.getPaperFile(request.params.id, "approved");
        if (!paper) {
            next(new HttpError(404, "Paper not found."));
            return;
        }
        if (fileStore.usesRemoteStorage) {
            await fileStore.download(paper.stored_file_name, paper.original_file_name, response, next);
            return;
        }
        const filePath = path.join(UPLOAD_DIR, path.basename(paper.stored_file_name));
        response.download(filePath, paper.original_file_name, (error) => {
            if (error && !response.headersSent) next(new HttpError(404, "The stored document could not be found."));
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/users", requireAuth, requireRole("Admin"), async (_request, response, next) => {
    try {
        const users = await store.listUsers();
        response.json({ users: users.map(publicUser) });
    } catch (error) {
        next(error);
    }
});

app.post("/api/users", requireAuth, requireRole("Admin"), async (request, response, next) => {
    try {
        const username = cleanText(request.body.username, "Username", 32);
        const password = cleanText(request.body.password, "Password", 200);
        const role = cleanText(request.body.role, "Role", 20);
        if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) {
            throw new HttpError(400, "Username must be 3–32 letters, numbers, dots, dashes, or underscores.");
        }
        if (!["Student", "Faculty", "Admin"].includes(role)) throw new HttpError(400, "Choose a valid user role.");
        if (password.length < 10) throw new HttpError(400, "Choose a password with at least 10 characters.");
        const credentials = await setPassword(password);
        const user = await store.createUser({
            username,
            password_salt: credentials.salt,
            password_hash: credentials.hash,
            role
        });
        response.status(201).json({ user: publicUser(user) });
    } catch (error) {
        if (String(error.message).includes("UNIQUE")) {
            next(new HttpError(409, "That username is already registered."));
            return;
        }
        next(error);
    }
});

app.patch("/api/users/:id", requireAuth, requireRole("Admin"), async (request, response, next) => {
    try {
        const existing = await store.getPublicUserById(request.params.id);
        if (!existing) throw new HttpError(404, "User not found.");
        const username = cleanText(request.body.username, "Username", 32);
        const role = cleanText(request.body.role, "Role", 20);
        if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) {
            throw new HttpError(400, "Username must be 3–32 letters, numbers, dots, dashes, or underscores.");
        }
        if (!["Student", "Faculty", "Admin"].includes(role)) throw new HttpError(400, "Choose a valid user role.");
        if (existing.id === request.user.id && role !== "Admin") {
            throw new HttpError(400, "You cannot remove your own Admin role.");
        }
        if (existing.role === "Admin" && role !== "Admin" &&
            await store.adminCount() < 2) {
            throw new HttpError(400, "The system must have at least one Admin.");
        }
        const password = request.body.password;
        if (password && (typeof password !== "string" || password.length < 10 || password.length > 200)) {
            throw new HttpError(400, "A new password must be between 10 and 200 characters.");
        }
        if (password) {
            const credentials = await setPassword(password);
            await store.updateUser(existing.id, {
                username,
                role,
                password_salt: credentials.salt,
                password_hash: credentials.hash
            });
        } else {
            await store.updateUser(existing.id, { username, role });
        }
        const user = await store.getPublicUserById(existing.id);
        response.json({ user: publicUser(user) });
    } catch (error) {
        if (String(error.message).includes("UNIQUE")) {
            next(new HttpError(409, "That username is already registered."));
            return;
        }
        next(error);
    }
});

app.delete("/api/users/:id", requireAuth, requireRole("Admin"), async (request, response, next) => {
    try {
        const user = await store.getPublicUserById(request.params.id);
        if (!user) throw new HttpError(404, "User not found.");
        if (user.id === request.user.id) throw new HttpError(400, "You cannot delete your own account while signed in.");
        if (user.role === "Admin" &&
            await store.adminCount() < 2) {
            throw new HttpError(400, "The system must have at least one Admin.");
        }
        await store.deleteUser(user.id);
        response.json({ success: true });
    } catch (error) {
        next(error);
    }
});

for (const [route, file, contentType] of [
    ["/", "research.html", "text/html; charset=utf-8"],
    ["/research.html", "research.html", "text/html; charset=utf-8"],
    ["/researchpart2.css", "researchpart2.css", "text/css; charset=utf-8"],
    ["/part3.script.js", "part3.script.js", "text/javascript; charset=utf-8"],
    ["/sti-logo.png", "sti-logo.png", "image/png"],
    ["/Index.html", "Index.html", "text/html; charset=utf-8"]
]) {
    app.get(route, (_request, response, next) => {
        response.type(contentType);
        response.set("Cache-Control", "no-store");
        response.sendFile(path.join(IS_VERCEL ? PUBLIC_DIR : ROOT, file), (error) => {
            if (error && !response.headersSent) next(error);
        });
    });
}

app.use((request, response) => {
    if (request.path.startsWith("/api/")) {
        response.status(404).json({ error: "API endpoint not found." });
        return;
    }
    response.status(404).send("Page not found.");
});

app.use((error, _request, response, _next) => {
    if (response.headersSent) return;
    const status = error instanceof HttpError || error instanceof FileStoreError
        ? error.status
        : error instanceof multer.MulterError
            ? error.code === "LIMIT_FILE_SIZE" ? 413 : 400
            : 500;
    if (status >= 500) {
        console.error("Request failed:", error.message);
    }
    const message = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
        ? "Files must be 10 MB or smaller."
        : error instanceof multer.MulterError
            ? "The uploaded file could not be processed."
            : status >= 500
                ? "The server encountered an unexpected error."
                : error.message;
    response.status(status).json({ error: message });
});

async function startServer() {
    await store.initialize();
    const count = await store.userCount();
    const server = app.listen(PORT, HOST, () => {
        console.log(`Research Hub running at http://localhost:${PORT}/research.html`);
        console.log(`Account and paper metadata: ${store.storageDescription}`);
        console.log(`Document files: ${UPLOAD_DIR}`);
        if (count === 0) {
            console.log("Create the first account in the website; it will become the Admin.");
        }
    });

    server.on("error", async (error) => {
        console.error(`Could not start the local server: ${error.message}`);
        await store.close();
        process.exitCode = 1;
    });
}

module.exports = app;

if (require.main === module && !IS_VERCEL) {
    startServer().catch(async (error) => {
        console.error(`Could not initialize the Research Hub data store: ${error.message}`);
        await store.close();
        process.exitCode = 1;
    });
}

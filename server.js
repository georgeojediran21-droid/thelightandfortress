const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { initDatabase } = require("./database");

function loadLocalEnv() {
    const envFile = path.join(__dirname, ".env");
    if (!fs.existsSync(envFile)) return;

    fs.readFileSync(envFile, "utf8").split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const separator = trimmed.indexOf("=");
        if (separator === -1) return;
        const key = trimmed.slice(0, separator).trim();
        const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
        if (key && !process.env[key]) process.env[key] = value;
    });
}

loadLocalEnv();

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const PROFILE_DIR = path.join(UPLOAD_DIR, "profiles");
const MEDIA_DIR = path.join(UPLOAD_DIR, "media");
const DB_FILE = path.join(DATA_DIR, "db.json");
const MAX_BODY_SIZE = 25 * 1024 * 1024;
const database = initDatabase({ dataDir: DATA_DIR, jsonFile: DB_FILE });

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".pdf": "application/pdf"
};

function ensureStorage() {
    database.ensureStorage();
    [UPLOAD_DIR, PROFILE_DIR, MEDIA_DIR].forEach((dir) => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
}

function readDb() {
    ensureStorage();
    const db = database.read();
    if (db.members.length && !db.members.some((member) => member.accountType === "admin")) {
        db.members[0].accountType = "admin";
        writeDb(db);
    }
    return db;
}

function writeDb(db) {
    database.write(db);
}

function sendJson(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
}

function redirect(res, location) {
    res.writeHead(302, { Location: location });
    res.end();
}

function getCookie(req, name) {
    const cookie = req.headers.cookie || "";
    const value = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.split("=")[1] || "";
    return decodeURIComponent(value);
}

function getSession(req, db) {
    const token = getCookie(req, "lf_session");
    if (!token || !db.sessions[token]) return null;
    const member = db.members.find((item) => item.id === db.sessions[token].memberId);
    if (!member) return null;
    return { token, member };
}

function sanitizeMember(member) {
    const { passwordHash, salt, ...safeMember } = member;
    return safeMember;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex");
    return { salt, passwordHash: hash };
}

function verifyPassword(password, member) {
    const attempted = hashPassword(password, member.salt);
    if (!member.passwordHash || attempted.passwordHash.length !== member.passwordHash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(attempted.passwordHash, "hex"), Buffer.from(member.passwordHash, "hex"));
}

function resetScopeFromFields(fields) {
    return fields.accountType === "admin" ? "admin" : "member";
}

function cleanExpiredPasswordResets(db) {
    const now = Date.now();
    Object.keys(db.passwordResets || {}).forEach((token) => {
        if (!db.passwordResets[token]?.expiresAt || new Date(db.passwordResets[token].expiresAt).getTime() <= now) {
            delete db.passwordResets[token];
        }
    });
}

function createPasswordReset(db, member, scope) {
    cleanExpiredPasswordResets(db);
    Object.keys(db.passwordResets).forEach((token) => {
        if (db.passwordResets[token].memberId === member.id) delete db.passwordResets[token];
    });

    const code = String(crypto.randomInt(100000, 1000000));
    const token = crypto.randomBytes(24).toString("hex");
    const codeData = hashPassword(code);
    db.passwordResets[token] = {
        memberId: member.id,
        scope,
        salt: codeData.salt,
        codeHash: codeData.passwordHash,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    };
    return { token, code };
}

function verifyResetCode(reset, code) {
    if (!reset || !code || new Date(reset.expiresAt).getTime() <= Date.now()) return false;
    const attempted = hashPassword(code, reset.salt);
    if (!reset.codeHash || attempted.passwordHash.length !== reset.codeHash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(attempted.passwordHash, "hex"), Buffer.from(reset.codeHash, "hex"));
}

async function sendPasswordResetEmail(member, code) {
    const user = process.env.GMAIL_USER || process.env.SMTP_USER;
    const pass = process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS;
    if (!user || !pass) {
        console.log(`Password reset code for ${member.email}: ${code}`);
        return { sent: false };
    }

    let nodemailer;
    try {
        nodemailer = require("nodemailer");
    } catch (error) {
        console.log(`Password reset code for ${member.email}: ${code}`);
        return { sent: false };
    }

    const transporter = nodemailer.createTransport({
        service: process.env.SMTP_SERVICE || "gmail",
        auth: { user, pass }
    });

    await transporter.sendMail({
        from: process.env.MAIL_FROM || user,
        to: member.email,
        subject: "The Light and Fortress Alliance password reset code",
        text: `Your password reset verification code is ${code}. It expires in 15 minutes.`
    });
    return { sent: true };
}

function collectBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                reject(new Error("Request body is too large."));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function parseForm(buffer) {
    return Object.fromEntries(new URLSearchParams(buffer.toString("utf8")));
}

function parseMultipart(buffer, contentType) {
    const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
    if (!boundary) return { fields: {}, files: {} };

    const raw = buffer.toString("latin1");
    const parts = raw.split(`--${boundary}`).slice(1, -1);
    const fields = {};
    const files = {};

    parts.forEach((part) => {
        const clean = part.replace(/^\r\n/, "");
        const divider = clean.indexOf("\r\n\r\n");
        if (divider === -1) return;

        const header = clean.slice(0, divider);
        let body = clean.slice(divider + 4);
        if (body.endsWith("\r\n")) body = body.slice(0, -2);

        const name = header.match(/name="([^"]+)"/)?.[1];
        const filename = header.match(/filename="([^"]*)"/)?.[1];
        const mimeType = header.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || "application/octet-stream";
        if (!name) return;

        if (filename) {
            files[name] = {
                filename: path.basename(filename),
                mimeType,
                buffer: Buffer.from(body, "latin1")
            };
        } else {
            fields[name] = Buffer.from(body, "latin1").toString("utf8");
        }
    });

    return { fields, files };
}

function safeFileName(originalName) {
    const ext = path.extname(originalName).toLowerCase();
    const base = path.basename(originalName, ext).replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "upload";
    return `${Date.now()}-${crypto.randomBytes(5).toString("hex")}-${base}${ext}`;
}

function saveUpload(file, folder, allowedTypes) {
    if (!file || !file.filename || file.buffer.length === 0) return "";
    if (allowedTypes.length && !allowedTypes.some((type) => file.mimeType.startsWith(type))) {
        throw new Error("Unsupported file type.");
    }
    if (file.buffer.length > MAX_BODY_SIZE) {
        throw new Error("File is too large. Please upload a file under 25MB.");
    }
    const fileName = safeFileName(file.filename);
    const filePath = path.join(folder, fileName);
    fs.writeFileSync(filePath, file.buffer);
    return `/uploads/${path.basename(folder)}/${fileName}`;
}

function requireLogin(req, res, db) {
    const session = getSession(req, db);
    if (!session) {
        sendJson(res, 401, { error: "Please login first." });
        return null;
    }
    return session;
}

function isAdmin(member) {
    return member && member.accountType === "admin";
}

function requireAdmin(req, res, db) {
    const session = requireLogin(req, res, db);
    if (!session) return null;
    if (!isAdmin(session.member)) {
        sendJson(res, 403, { error: "Admin access is required." });
        return null;
    }
    return session;
}

function removeUploadFile(fileUrl) {
    if (!fileUrl || !fileUrl.startsWith("/uploads/")) return;
    const filePath = path.normalize(path.join(ROOT, fileUrl));
    if (filePath.startsWith(UPLOAD_DIR) && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

async function handleApi(req, res) {
    const db = readDb();
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/api/register") {
        const body = await collectBody(req);
        const contentType = req.headers["content-type"] || "";
        const { fields, files } = contentType.includes("multipart/form-data")
            ? parseMultipart(body, contentType)
            : { fields: parseForm(body), files: {} };

        const name = (fields.name || "").trim();
        const email = (fields.email || "").trim().toLowerCase();
        const password = fields.password || "";
        const phone = (fields.phone || "").trim();
        const location = (fields.location || "").trim();
        const role = (fields.role || "Member").trim();
        const bio = (fields.bio || "").trim();

        if (!name || !email || !password) return sendJson(res, 400, { error: "Name, email, and password are required." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: "Please enter a valid email address." });
        if (password.length < 6) return sendJson(res, 400, { error: "Password must be at least 6 characters." });
        if (db.members.some((member) => member.email === email)) return sendJson(res, 409, { error: "A member with this email already exists." });

        let profilePicture = "";
        try {
            profilePicture = saveUpload(files.profilePicture, PROFILE_DIR, ["image/"]);
        } catch (error) {
            return sendJson(res, 400, { error: error.message });
        }

        const passwordData = hashPassword(password);
        const member = {
            id: crypto.randomUUID(),
            name,
            email,
            phone,
            location,
            role,
            bio,
            accountType: db.members.length === 0 ? "admin" : "member",
            profilePicture,
            visibility: fields.visibility === "private" ? "private" : "public",
            joinedAt: new Date().toISOString(),
            ...passwordData
        };

        db.members.push(member);
        db.notifications.push({
            id: crypto.randomUUID(),
            title: "New member registered",
            message: `${name} joined The Light and Fortress Alliance.`,
            createdAt: new Date().toISOString()
        });
        writeDb(db);
        return sendJson(res, 201, { message: "Registration successful.", member: sanitizeMember(member) });
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
        const fields = parseForm(await collectBody(req));
        const email = (fields.email || "").trim().toLowerCase();
        const password = fields.password || "";
        if (!email || !password) return sendJson(res, 400, { error: "Email and password are required." });
        const member = db.members.find((item) => item.email === email);
        if (!member || !verifyPassword(password, member)) return sendJson(res, 401, { error: "Invalid email or password." });

        const token = crypto.randomBytes(32).toString("hex");
        db.sessions[token] = { memberId: member.id, createdAt: new Date().toISOString() };
        writeDb(db);
        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Set-Cookie": `lf_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`
        });
        return res.end(JSON.stringify({ message: "Login successful.", member: sanitizeMember(member) }));
    }

    if (req.method === "POST" && url.pathname === "/api/password-reset/request") {
        const fields = parseForm(await collectBody(req));
        const email = (fields.email || "").trim().toLowerCase();
        const scope = resetScopeFromFields(fields);
        if (!email) return sendJson(res, 400, { error: "Email is required." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: "Please enter a valid email address." });

        const member = db.members.find((item) => item.email === email);
        if (!member || (scope === "admin" && !isAdmin(member))) {
            return sendJson(res, 404, { error: scope === "admin" ? "No admin account uses that email." : "No member account uses that email." });
        }

        const reset = createPasswordReset(db, member, scope);
        let mail;
        try {
            mail = await sendPasswordResetEmail(member, reset.code);
        } catch (error) {
            console.error("Password reset email failed:", error?.message || error);
            return sendJson(res, 500, { error: "Could not send the verification email. Check the mail settings and try again." });
        }
        writeDb(db);
        return sendJson(res, 200, {
            message: mail.sent
                ? "Verification code sent. Check your email."
                : "Verification code created. Email is not configured, so check the server console for the code.",
            resetToken: reset.token,
            emailConfigured: mail.sent
        });
    }

    if (req.method === "POST" && url.pathname === "/api/forgot-password") {
        const fields = parseForm(await collectBody(req));
        const email = (fields.email || "").trim().toLowerCase();
        const password = fields.password || "";
        const resetToken = fields.resetToken || "";
        const verificationCode = (fields.verificationCode || "").trim();
        const scope = resetScopeFromFields(fields);
        if (!email || !password || !resetToken || !verificationCode) return sendJson(res, 400, { error: "Email, verification code, and new password are required." });
        if (password.length < 6) return sendJson(res, 400, { error: "Password must be at least 6 characters." });
        const member = db.members.find((item) => item.email === email);
        if (!member || (scope === "admin" && !isAdmin(member))) return sendJson(res, 404, { error: scope === "admin" ? "No admin account uses that email." : "No member account uses that email." });

        cleanExpiredPasswordResets(db);
        const reset = db.passwordResets[resetToken];
        if (!reset || reset.memberId !== member.id || reset.scope !== scope || !verifyResetCode(reset, verificationCode)) {
            writeDb(db);
            return sendJson(res, 400, { error: "Invalid or expired verification code." });
        }

        const passwordData = hashPassword(password);
        member.salt = passwordData.salt;
        member.passwordHash = passwordData.passwordHash;
        delete db.passwordResets[resetToken];
        Object.keys(db.sessions).forEach((token) => {
            if (db.sessions[token].memberId === member.id) delete db.sessions[token];
        });
        db.notifications.unshift({
            id: crypto.randomUUID(),
            title: "Password changed",
            message: `${member.name} reset their account password.`,
            createdAt: new Date().toISOString()
        });
        writeDb(db);
        return sendJson(res, 200, { message: "Password reset successful. You can now login." });
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
        const token = getCookie(req, "lf_session");
        if (token) delete db.sessions[token];
        writeDb(db);
        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Set-Cookie": "lf_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"
        });
        return res.end(JSON.stringify({ message: "Logged out." }));
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
        const session = getSession(req, db);
        return sendJson(res, 200, { member: session ? sanitizeMember(session.member) : null });
    }

    if (req.method === "GET" && url.pathname === "/api/members") {
        const session = requireLogin(req, res, db);
        if (!session) return;
        const members = db.members
            .filter((member) => member.visibility === "public" || member.id === session?.member.id || isAdmin(session?.member))
            .map(sanitizeMember);
        return sendJson(res, 200, { members });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/members/")) {
        const session = requireLogin(req, res, db);
        if (!session) return;
        const id = url.pathname.split("/").pop();
        const member = db.members.find((item) => item.id === id);
        if (!member || (member.visibility === "private" && member.id !== session?.member.id && !isAdmin(session?.member))) return sendJson(res, 404, { error: "Member not found." });
        return sendJson(res, 200, { member: sanitizeMember(member) });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/members") {
        const session = requireAdmin(req, res, db);
        if (!session) return;

        const body = await collectBody(req);
        const contentType = req.headers["content-type"] || "";
        const { fields, files } = contentType.includes("multipart/form-data")
            ? parseMultipart(body, contentType)
            : { fields: parseForm(body), files: {} };

        const name = (fields.name || "").trim();
        const email = (fields.email || "").trim().toLowerCase();
        const password = fields.password || "";
        const phone = (fields.phone || "").trim();
        const location = (fields.location || "").trim();
        const role = (fields.role || "Member").trim();
        const bio = (fields.bio || "").trim();

        if (!name || !email || !password) return sendJson(res, 400, { error: "Name, email, and password are required." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: "Please enter a valid email address." });
        if (password.length < 6) return sendJson(res, 400, { error: "Password must be at least 6 characters." });
        if (db.members.some((member) => member.email === email)) return sendJson(res, 409, { error: "A member with this email already exists." });

        let profilePicture = "";
        try {
            profilePicture = saveUpload(files.profilePicture, PROFILE_DIR, ["image/"]);
        } catch (error) {
            return sendJson(res, 400, { error: error.message });
        }

        const passwordData = hashPassword(password);
        const member = {
            id: crypto.randomUUID(),
            name,
            email,
            phone,
            location,
            role,
            bio,
            accountType: fields.accountType === "admin" ? "admin" : "member",
            profilePicture,
            visibility: fields.visibility === "private" ? "private" : "public",
            joinedAt: new Date().toISOString(),
            createdBy: session.member.id,
            ...passwordData
        };

        db.members.push(member);
        db.notifications.unshift({
            id: crypto.randomUUID(),
            title: "Account created",
            message: `${session.member.name} created an account for ${name}.`,
            createdAt: new Date().toISOString()
        });
        writeDb(db);
        return sendJson(res, 201, { message: "Account created.", member: sanitizeMember(member) });
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/admin/members/")) {
        const session = requireAdmin(req, res, db);
        if (!session) return;
        const id = url.pathname.split("/").pop();
        const member = db.members.find((item) => item.id === id);
        if (!member) return sendJson(res, 404, { error: "Member not found." });

        const body = await collectBody(req);
        const contentType = req.headers["content-type"] || "";
        const { fields, files } = contentType.includes("multipart/form-data")
            ? parseMultipart(body, contentType)
            : { fields: parseForm(body), files: {} };
        member.name = (fields.name || member.name).trim();
        member.email = (fields.email || member.email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email)) return sendJson(res, 400, { error: "Please enter a valid email address." });
        if (db.members.some((item) => item.id !== member.id && item.email === member.email)) return sendJson(res, 409, { error: "Another member already uses this email." });
        member.phone = (fields.phone || "").trim();
        member.location = (fields.location || "").trim();
        member.role = (fields.role || "Member").trim();
        member.bio = (fields.bio || "").trim();
        member.visibility = fields.visibility === "private" ? "private" : "public";
        member.accountType = fields.accountType === "admin" ? "admin" : "member";

        if (fields.password) {
            if (fields.password.length < 6) return sendJson(res, 400, { error: "Password must be at least 6 characters." });
            const passwordData = hashPassword(fields.password);
            member.salt = passwordData.salt;
            member.passwordHash = passwordData.passwordHash;
        }

        try {
            const profilePicture = saveUpload(files.profilePicture, PROFILE_DIR, ["image/"]);
            if (profilePicture) {
                removeUploadFile(member.profilePicture);
                member.profilePicture = profilePicture;
            }
        } catch (error) {
            return sendJson(res, 400, { error: error.message });
        }

        const adminCount = db.members.filter((item) => item.accountType === "admin").length;
        if (session.member.id === member.id && member.accountType !== "admin" && adminCount <= 1) {
            return sendJson(res, 400, { error: "You cannot remove the last admin account." });
        }

        writeDb(db);
        return sendJson(res, 200, { message: "Member updated.", member: sanitizeMember(member) });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/members/")) {
        const session = requireAdmin(req, res, db);
        if (!session) return;
        const id = url.pathname.split("/").pop();
        const member = db.members.find((item) => item.id === id);
        if (!member) return sendJson(res, 404, { error: "Member not found." });
        if (member.id === session.member.id) return sendJson(res, 400, { error: "You cannot delete your own admin account." });

        removeUploadFile(member.profilePicture);
        db.members = db.members.filter((item) => item.id !== id);
        db.updates = db.updates.filter((item) => item.memberId !== id);
        db.uploads.filter((item) => item.memberId === id).forEach((item) => removeUploadFile(item.fileUrl));
        db.uploads = db.uploads.filter((item) => item.memberId !== id);
        Object.keys(db.sessions).forEach((token) => {
            if (db.sessions[token].memberId === id) delete db.sessions[token];
        });
        writeDb(db);
        return sendJson(res, 200, { message: "Member deleted." });
    }

    if (req.method === "POST" && url.pathname === "/api/updates") {
        const session = requireAdmin(req, res, db);
        if (!session) return;
        const fields = parseForm(await collectBody(req));
        const title = (fields.title || "").trim();
        const message = (fields.message || "").trim();
        if (!title || !message) return sendJson(res, 400, { error: "Title and message are required." });

        const update = {
            id: crypto.randomUUID(),
            memberId: session.member.id,
            memberName: session.member.name,
            title,
            message,
            createdAt: new Date().toISOString()
        };
        db.updates.unshift(update);
        db.notifications.unshift({
            id: crypto.randomUUID(),
            title: "New update",
            message: `${session.member.name}: ${title}`,
            createdAt: new Date().toISOString()
        });
        writeDb(db);
        return sendJson(res, 201, { message: "Update posted.", update });
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/admin/updates/")) {
        const session = requireAdmin(req, res, db);
        if (!session) return;
        const id = url.pathname.split("/").pop();
        const update = db.updates.find((item) => item.id === id);
        if (!update) return sendJson(res, 404, { error: "Update not found." });
        const fields = parseForm(await collectBody(req));
        const title = (fields.title || "").trim();
        const message = (fields.message || "").trim();
        if (!title || !message) return sendJson(res, 400, { error: "Title and message are required." });
        update.title = title;
        update.message = message;
        update.editedAt = new Date().toISOString();
        writeDb(db);
        return sendJson(res, 200, { message: "Update changed.", update });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/updates/")) {
        const session = requireAdmin(req, res, db);
        if (!session) return;
        const id = url.pathname.split("/").pop();
        db.updates = db.updates.filter((item) => item.id !== id);
        writeDb(db);
        return sendJson(res, 200, { message: "Update deleted." });
    }

    if (req.method === "GET" && url.pathname === "/api/updates") {
        return sendJson(res, 200, { updates: db.updates });
    }

    if (req.method === "GET" && url.pathname === "/api/notifications") {
        const session = requireLogin(req, res, db);
        if (!session) return;
        return sendJson(res, 200, { notifications: db.notifications.slice(0, 50) });
    }

    if (req.method === "POST" && url.pathname === "/api/uploads") {
        const session = requireAdmin(req, res, db);
        if (!session) return;
        const contentType = req.headers["content-type"] || "";
        if (!contentType.includes("multipart/form-data")) return sendJson(res, 400, { error: "Upload form must use multipart/form-data." });

        const { fields, files } = parseMultipart(await collectBody(req), contentType);
        const title = (fields.title || "").trim() || "Untitled upload";
        let fileUrl = "";
        try {
            fileUrl = saveUpload(files.media, MEDIA_DIR, ["image/", "video/"]);
        } catch (error) {
            return sendJson(res, 400, { error: error.message });
        }
        if (!fileUrl) return sendJson(res, 400, { error: "Please choose an image or video file." });

        const upload = {
            id: crypto.randomUUID(),
            memberId: session.member.id,
            memberName: session.member.name,
            title,
            fileUrl,
            fileType: files.media.mimeType,
            createdAt: new Date().toISOString()
        };
        db.uploads.unshift(upload);
        db.notifications.unshift({
            id: crypto.randomUUID(),
            title: "New media upload",
            message: `${session.member.name} uploaded ${title}.`,
            createdAt: new Date().toISOString()
        });
        writeDb(db);
        return sendJson(res, 201, { message: "Upload saved.", upload });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/uploads/")) {
        const session = requireAdmin(req, res, db);
        if (!session) return;
        const id = url.pathname.split("/").pop();
        const upload = db.uploads.find((item) => item.id === id);
        if (!upload) return sendJson(res, 404, { error: "Upload not found." });
        removeUploadFile(upload.fileUrl);
        db.uploads = db.uploads.filter((item) => item.id !== id);
        writeDb(db);
        return sendJson(res, 200, { message: "Upload deleted." });
    }

    if (req.method === "GET" && url.pathname === "/api/uploads") {
        return sendJson(res, 200, { uploads: db.uploads });
    }

    sendJson(res, 404, { error: "API route not found." });
}

function serveStatic(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";

    const requestedPath = path.normalize(path.join(ROOT, pathname));
    if (!requestedPath.startsWith(ROOT)) return sendJson(res, 403, { error: "Forbidden." });

    fs.stat(requestedPath, (error, stat) => {
        if (error || !stat.isFile()) {
            res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<h1>404 - Page not found</h1>");
            return;
        }

        const ext = path.extname(requestedPath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
        fs.createReadStream(requestedPath).pipe(res);
    });
}

ensureStorage();

http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
        handleApi(req, res).catch((error) => {
            console.error(error);
            const status = error.message === "Request body is too large." ? 413 : 500;
            sendJson(res, status, { error: status === 413 ? error.message : "Server error." });
        });
        return;
    }

    if (req.url === "/logout") {
        const db = readDb();
        const token = getCookie(req, "lf_session");
        if (token) delete db.sessions[token];
        writeDb(db);
        res.writeHead(302, {
            Location: "/login.html",
            "Set-Cookie": "lf_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"
        });
        res.end();
        return;
    }

    serveStatic(req, res);
}).listen(PORT, () => {
    console.log(`The Light and Fortress backend is running at http://localhost:${PORT}`);
});

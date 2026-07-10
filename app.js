async function api(path, options = {}) {
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Something went wrong.");
    return data;
}

function showMessage(targetId, message, type = "success") {
    const target = document.getElementById(targetId);
    if (!target) return;
    target.innerHTML = `<div class="alert alert-${type}" role="alert">${escapeHtml(message)}</div>`;
}

function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    }[character]));
}

function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
}

function memberImage(member) {
    return member.profilePicture || "ChatGPT Image Jun 18, 2026, 01_53_04 AM.png";
}

function formatDate(value) {
    return new Date(value).toLocaleString();
}

function isAdmin(member) {
    return member && member.accountType === "admin";
}

let loadedNotifications = [];

async function setupAuthNav() {
    const areas = document.querySelectorAll("[data-auth-nav]");
    if (!areas.length) return;
    const { member } = await api("/api/me");
    areas.forEach((area) => {
        const nav = area.closest(".navbar-nav") || document;
        const memberLinks = member
            ? [
                !nav.querySelector('a[href="members.html"]') ? `<a class="nav-link" href="members.html">Members</a>` : "",
                !nav.querySelector('a[href="dashboard.html"]') ? `<a class="nav-link" href="dashboard.html">Dashboard</a>` : "",
                !nav.querySelector('a[href="notification.html"]') ? `<a class="nav-link nav-notification" href="notification.html" aria-label="Notifications">Notifications</a>` : ""
            ].join("")
            : "";
        const html = member
            ? `${memberLinks}${isAdmin(member) ? `<a class="nav-link" href="admin-dashboard.html">Admin</a>` : ""}<a class="nav-link" href="login.html" data-logout>Logout</a>`
            : `<a class="nav-link" href="login.html">Login</a><a class="nav-link nav-register" href="register.html">Register</a>`;
        area.innerHTML = html;
    });
}

function initLogoutLinks() {
    document.addEventListener("click", async (event) => {
        const logoutLink = event.target.closest("[data-logout]");
        if (!logoutLink) return;

        event.preventDefault();
        await api("/api/logout", { method: "POST" }).catch(() => {});
        window.location.href = logoutLink.getAttribute("href") || "login.html";
    });
}

async function requireMember() {
    const { member } = await api("/api/me");
    if (!member) {
        window.location.href = "login.html";
        return null;
    }
    return member;
}

function initRegister() {
    const form = document.getElementById("registerForm");
    if (!form) return;
    const password = document.getElementById("registerPassword");
    const showPassword = document.getElementById("showRegisterPassword");
    if (password && showPassword) {
        showPassword.addEventListener("change", () => {
            password.type = showPassword.checked ? "text" : "password";
        });
    }
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
            await api("/api/register", { method: "POST", body: new FormData(form) });
            showMessage("registerMessage", "Registration successful. You can now login.", "success");
            form.reset();
        } catch (error) {
            showMessage("registerMessage", error.message, "danger");
        }
    });
}

function initForgotPassword() {
    const form = document.getElementById("forgotPasswordForm");
    if (!form) return;
    const password = document.getElementById("resetPassword");
    const showPassword = document.getElementById("showResetPassword");
    const sendCode = document.getElementById("sendResetCode");
    const resetToken = document.getElementById("resetToken");
    const resetSteps = document.querySelectorAll("[data-reset-step]");
    const scope = form.dataset.resetScope || "member";
    if (password && showPassword) {
        showPassword.addEventListener("change", () => {
            password.type = showPassword.checked ? "text" : "password";
        });
    }
    if (sendCode) {
        sendCode.addEventListener("click", async () => {
            const email = form.elements.email?.value.trim();
            if (!email) {
                showMessage("forgotPasswordMessage", "Enter your email first.", "danger");
                return;
            }

            sendCode.disabled = true;
            try {
                const data = await api("/api/password-reset/request", {
                    method: "POST",
                    body: new URLSearchParams({ email, accountType: scope })
                });
                if (resetToken) resetToken.value = data.resetToken || "";
                resetSteps.forEach((step) => {
                    step.hidden = false;
                });
                showMessage("forgotPasswordMessage", data.message || "Verification code sent.", "success");
            } catch (error) {
                showMessage("forgotPasswordMessage", error.message, "danger");
            } finally {
                sendCode.disabled = false;
            }
        });
    }
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
            const body = new URLSearchParams(new FormData(form));
            if (!body.get("resetToken")) {
                showMessage("forgotPasswordMessage", "Send the verification code first.", "danger");
                return;
            }
            body.set("accountType", scope);
            await api("/api/forgot-password", { method: "POST", body });
            showMessage("forgotPasswordMessage", "Password reset successful. You can now login.", "success");
            form.reset();
            if (resetToken) resetToken.value = "";
            resetSteps.forEach((step) => {
                step.hidden = true;
            });
        } catch (error) {
            showMessage("forgotPasswordMessage", error.message, "danger");
        }
    });
}

function initLogin() {
    const form = document.getElementById("loginForm");
    if (!form) return;
    const password = document.getElementById("loginPassword");
    const showPassword = document.getElementById("showPassword");
    if (password && showPassword) {
        showPassword.addEventListener("change", () => {
            password.type = showPassword.checked ? "text" : "password";
        });
    }
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
            const body = new URLSearchParams(new FormData(form));
            await api("/api/login", { method: "POST", body });
            window.location.href = "dashboard.html";
        } catch (error) {
            showMessage("loginMessage", error.message, "danger");
        }
    });
}

function initAdminLogin() {
    const form = document.getElementById("adminLoginForm");
    if (!form) return;
    const password = document.getElementById("adminLoginPassword");
    const showPassword = document.getElementById("showAdminPassword");
    if (password && showPassword) {
        showPassword.addEventListener("change", () => {
            password.type = showPassword.checked ? "text" : "password";
        });
    }
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
            const { member } = await api("/api/login", { method: "POST", body: new URLSearchParams(new FormData(form)) });
            if (!isAdmin(member)) {
                await api("/api/logout", { method: "POST" }).catch(() => {});
                showMessage("adminLoginMessage", "This account is not an admin account.", "danger");
                return;
            }
            window.location.href = "admin-dashboard.html";
        } catch (error) {
            showMessage("adminLoginMessage", error.message, "danger");
        }
    });
}

async function initDashboard() {
    const dashboard = document.getElementById("dashboard");
    if (!dashboard) return;
    const member = await requireMember();
    if (!member) return;
    document.querySelectorAll("[data-admin-only]").forEach((element) => {
        element.hidden = !isAdmin(member);
    });
    dashboard.innerHTML = `
        <div class="member-profile card shadow-sm">
            <img src="${escapeAttribute(memberImage(member))}" alt="${escapeAttribute(member.name)}">
            <div>
                <p class="eyebrow">Member dashboard</p>
                <h2>${escapeHtml(member.name)}</h2>
                <p>${escapeHtml(member.role || "Member")} | ${escapeHtml(member.accountType || "member")} | ${escapeHtml(member.location || "No location added")}</p>
                <p>${escapeHtml(member.bio || "No bio added yet.")}</p>
                ${isAdmin(member) ? `<a class="btn btn-sm" href="admin-dashboard.html">Open Admin Panel</a>` : ""}
            </div>
        </div>
    `;
    await Promise.all([loadUpdates(), loadNotifications(), loadUploads()]);
}

async function loadMembers() {
    const list = document.getElementById("membersList");
    if (!list) return;
    const member = await requireMember();
    if (!member) return;
    const { members } = await api("/api/members");
    list.innerHTML = members.map((member) => `
        <div class="col-md-6 col-lg-4">
            <article class="member-card card shadow-sm h-100">
                <img src="${escapeAttribute(memberImage(member))}" alt="${escapeAttribute(member.name)}">
                <div class="card-body">
                    <h3>${escapeHtml(member.name)}</h3>
                    <p><strong>Role:</strong> ${escapeHtml(member.role || "Member")}</p>
                    <p><strong>Email:</strong> ${escapeHtml(member.email)}</p>
                    <p><strong>Phone:</strong> ${escapeHtml(member.phone || "Not added")}</p>
                    <p><strong>Location:</strong> ${escapeHtml(member.location || "Not added")}</p>
                    <p>${escapeHtml(member.bio || "")}</p>
                </div>
            </article>
        </div>
    `).join("");
}

async function requireAdmin() {
    const member = await requireMember();
    if (!member) return null;
    if (!isAdmin(member)) window.location.href = "dashboard.html";
    return member;
}

function memberAdminForm(member) {
    return `
        <form class="admin-member-form" data-member-id="${escapeAttribute(member.id)}" enctype="multipart/form-data">
            <div class="admin-member-summary">
                <img src="${escapeAttribute(memberImage(member))}" alt="${escapeAttribute(member.name)}">
                <div>
                    <strong>${escapeHtml(member.name)}</strong>
                    <span>${escapeHtml(member.accountType || "member")} | ${escapeHtml(member.role || "Member")}</span>
                </div>
            </div>
            <div class="row g-2">
                <div class="col-md-6"><input class="form-control" name="name" value="${escapeAttribute(member.name)}" required></div>
                <div class="col-md-6"><input class="form-control" type="email" name="email" value="${escapeAttribute(member.email)}" required></div>
                <div class="col-md-6"><input class="form-control" name="phone" value="${escapeAttribute(member.phone || "")}" placeholder="Phone"></div>
                <div class="col-md-6"><input class="form-control" name="location" value="${escapeAttribute(member.location || "")}" placeholder="Location"></div>
                <div class="col-md-6"><input class="form-control" name="role" value="${escapeAttribute(member.role || "Member")}" placeholder="Role"></div>
                <div class="col-md-6"><input class="form-control" type="password" name="password" minlength="6" placeholder="New password, optional"></div>
                <div class="col-md-3"><select class="form-select" name="visibility"><option value="public"${member.visibility !== "private" ? " selected" : ""}>Public</option><option value="private"${member.visibility === "private" ? " selected" : ""}>Private</option></select></div>
                <div class="col-md-3"><select class="form-select" name="accountType"><option value="member"${member.accountType !== "admin" ? " selected" : ""}>Member</option><option value="admin"${member.accountType === "admin" ? " selected" : ""}>Admin</option></select></div>
                <div class="col-md-6"><input class="form-control" type="file" name="profilePicture" accept="image/*"></div>
                <div class="col-12"><textarea class="form-control" name="bio" rows="2" placeholder="Bio">${escapeHtml(member.bio || "")}</textarea></div>
            </div>
            <div class="actions mt-3">
                <button class="btn btn-sm" type="submit">Save</button>
                <button class="btn btn-sm secondary" type="button" data-delete-member="${escapeAttribute(member.id)}">Delete</button>
            </div>
        </form>
    `;
}

async function loadAdminMembers() {
    const list = document.getElementById("adminMembersList");
    if (!list) return;
    const { members } = await api("/api/members");
    list.innerHTML = members.map((member) => `
        <article class="copy-card card shadow-sm">
            <h3>${escapeHtml(member.name)}</h3>
            <p>${escapeHtml(member.email)} | ${escapeHtml(member.accountType || "member")}</p>
            ${memberAdminForm(member)}
        </article>
    `).join("") || `<p class="text-muted">No members yet.</p>`;
}

async function loadAdminUpdates() {
    const list = document.getElementById("adminUpdatesList");
    if (!list) return;
    const { updates } = await api("/api/updates");
    list.innerHTML = updates.map((update) => `
        <article class="copy-card card shadow-sm">
            <form class="admin-update-form" data-update-id="${escapeAttribute(update.id)}">
                <input class="form-control mb-2" name="title" value="${escapeAttribute(update.title)}" required>
                <textarea class="form-control mb-2" name="message" rows="3" required>${escapeHtml(update.message)}</textarea>
                <small>Posted by ${escapeHtml(update.memberName)} on ${escapeHtml(formatDate(update.createdAt))}</small>
                <div class="actions mt-3">
                    <button class="btn btn-sm" type="submit">Save</button>
                    <button class="btn btn-sm secondary" type="button" data-delete-update="${escapeAttribute(update.id)}">Delete</button>
                </div>
            </form>
        </article>
    `).join("") || `<p class="text-muted">No updates yet.</p>`;
}

async function loadAdminUploads() {
    const list = document.getElementById("adminUploadsList");
    if (!list) return;
    const { uploads } = await api("/api/uploads");
    list.innerHTML = uploads.map((upload) => {
        const media = upload.fileType.startsWith("video/")
            ? `<video controls src="${escapeAttribute(upload.fileUrl)}"></video>`
            : `<img src="${escapeAttribute(upload.fileUrl)}" alt="${escapeAttribute(upload.title)}">`;
        return `
            <article class="media-card card shadow-sm">
                ${media}
                <div class="card-body">
                    <h3>${escapeHtml(upload.title)}</h3>
                    <p>Uploaded by ${escapeHtml(upload.memberName)}</p>
                    <button class="btn btn-sm secondary" type="button" data-delete-upload="${escapeAttribute(upload.id)}">Delete</button>
                </div>
            </article>
        `;
    }).join("") || `<p class="text-muted">No uploads yet.</p>`;
}

async function loadUpdates() {
    const list = document.getElementById("updatesList");
    if (!list) return;
    const { updates } = await api("/api/updates");
    list.innerHTML = updates.length ? updates.map((update) => `
        <article class="copy-card card shadow-sm">
            <div class="card-body">
                <h3>${escapeHtml(update.title)}</h3>
                <p>${escapeHtml(update.message)}</p>
                <small>Posted by ${escapeHtml(update.memberName)} on ${escapeHtml(formatDate(update.createdAt))}</small>
            </div>
        </article>
    `).join("") : `<p class="text-muted">No updates yet.</p>`;
}

async function loadNotifications() {
    const list = document.getElementById("notificationsList");
    if (!list) return;
    const { notifications } = await api("/api/notifications");
    loadedNotifications = notifications;
    list.innerHTML = notifications.length ? notifications.map((note) => `
        <a class="notification-module support-action card shadow-sm" href="notification.html?id=${escapeAttribute(note.id)}" data-notification-id="${escapeAttribute(note.id)}">
            <h3>${escapeHtml(note.title)}</h3>
            <p>${escapeHtml(note.message)}</p>
            <small>${escapeHtml(formatDate(note.createdAt))}</small>
        </a>
    `).join("") : `<p class="text-muted">No notifications yet.</p>`;
}

function initNotificationModal() {
    document.addEventListener("click", (event) => {
        const trigger = event.target.closest("[data-notification-id]");
        if (!trigger) return;
        if (trigger.tagName === "A") return;

        const note = loadedNotifications.find((item) => item.id === trigger.dataset.notificationId);
        const modalElement = document.getElementById("notificationModal");
        if (!note || !modalElement || !window.bootstrap) return;

        document.getElementById("notificationModalTitle").textContent = note.title || "Notification";
        document.getElementById("notificationModalMessage").textContent = note.message || "";
        document.getElementById("notificationModalDate").textContent = formatDate(note.createdAt);
        window.bootstrap.Modal.getOrCreateInstance(modalElement).show();
    });
}

async function initNotificationPage() {
    const detail = document.getElementById("notificationDetail");
    if (!detail) return;
    const member = await requireMember();
    if (!member) return;
    const { notifications } = await api("/api/notifications");
    loadedNotifications = notifications;
    const id = new URLSearchParams(window.location.search).get("id");
    const note = id ? notifications.find((item) => item.id === id) : notifications[0];

    if (!note) {
        detail.innerHTML = `<p class="text-muted">No notifications yet.</p>`;
        return;
    }

    detail.innerHTML = `
        <article class="notification-detail copy-card card shadow-sm">
            <div class="card-body">
                <p class="eyebrow">Notification</p>
                <h2>${escapeHtml(note.title)}</h2>
                <p>${escapeHtml(note.message)}</p>
                <small>${escapeHtml(formatDate(note.createdAt))}</small>
            </div>
        </article>
    `;
}

async function loadUploads() {
    const list = document.getElementById("uploadsList");
    if (!list) return;
    const { uploads } = await api("/api/uploads");
    list.innerHTML = uploads.length ? uploads.map((upload) => {
        const media = upload.fileType.startsWith("video/")
            ? `<video controls src="${escapeAttribute(upload.fileUrl)}"></video>`
            : `<img src="${escapeAttribute(upload.fileUrl)}" alt="${escapeAttribute(upload.title)}">`;
        return `
            <article class="media-card card shadow-sm">
                ${media}
                <div class="card-body">
                    <h3>${escapeHtml(upload.title)}</h3>
                    <p>Uploaded by ${escapeHtml(upload.memberName)}</p>
                    <small>${escapeHtml(formatDate(upload.createdAt))}</small>
                </div>
            </article>
        `;
    }).join("") : `<p class="text-muted">No uploads yet.</p>`;
}

function initUpdateForm() {
    const form = document.getElementById("updateForm");
    if (!form) return;
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
            await api("/api/updates", { method: "POST", body: new URLSearchParams(new FormData(form)) });
            form.reset();
            showMessage("updateMessage", "Update posted.", "success");
            await loadUpdates();
            await loadAdminUpdates();
            await loadNotifications();
        } catch (error) {
            showMessage("updateMessage", error.message, "danger");
        }
    });
}

function initUploadForm() {
    const form = document.getElementById("uploadForm");
    if (!form) return;
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
            await api("/api/uploads", { method: "POST", body: new FormData(form) });
            form.reset();
            showMessage("uploadMessage", "Media uploaded.", "success");
            await loadUploads();
            await loadAdminUploads();
            await loadNotifications();
        } catch (error) {
            showMessage("uploadMessage", error.message, "danger");
        }
    });
}

async function refreshAdmin() {
    await Promise.all([loadAdminMembers(), loadAdminUpdates(), loadAdminUploads(), loadNotifications()]);
}

function initAdminPanel() {
    const panel = document.getElementById("adminPanel");
    if (!panel) return;

    requireAdmin().then((member) => {
        if (member) refreshAdmin();
    }).catch(() => {});

    document.addEventListener("submit", async (event) => {
        if (event.target.matches("#adminCreateMemberForm")) {
            event.preventDefault();
            try {
                await api("/api/admin/members", { method: "POST", body: new FormData(event.target) });
                event.target.reset();
                showMessage("adminCreateMemberMessage", "Account created.", "success");
                await loadAdminMembers();
                await loadNotifications();
            } catch (error) {
                showMessage("adminCreateMemberMessage", error.message, "danger");
            }
        }

        if (event.target.matches(".admin-member-form")) {
            event.preventDefault();
            const id = event.target.dataset.memberId;
            try {
                await api(`/api/admin/members/${id}`, { method: "PUT", body: new FormData(event.target) });
                showMessage("adminMessage", "Member saved.", "success");
                await loadAdminMembers();
            } catch (error) {
                showMessage("adminMessage", error.message, "danger");
            }
        }

        if (event.target.matches(".admin-update-form")) {
            event.preventDefault();
            const id = event.target.dataset.updateId;
            try {
                await api(`/api/admin/updates/${id}`, { method: "PUT", body: new URLSearchParams(new FormData(event.target)) });
                showMessage("adminMessage", "Update saved.", "success");
                await loadAdminUpdates();
                await loadUpdates();
            } catch (error) {
                showMessage("adminMessage", error.message, "danger");
            }
        }
    });

    document.addEventListener("click", async (event) => {
        const memberId = event.target.dataset.deleteMember;
        const updateId = event.target.dataset.deleteUpdate;
        const uploadId = event.target.dataset.deleteUpload;
        if (!memberId && !updateId && !uploadId) return;

        if (!confirm("Delete this item?")) return;

        try {
            if (memberId) {
                await api(`/api/admin/members/${memberId}`, { method: "DELETE" });
                await loadAdminMembers();
            }
            if (updateId) {
                await api(`/api/admin/updates/${updateId}`, { method: "DELETE" });
                await loadAdminUpdates();
            }
            if (uploadId) {
                await api(`/api/admin/uploads/${uploadId}`, { method: "DELETE" });
                await loadAdminUploads();
            }
            showMessage("adminMessage", "Deleted.", "success");
        } catch (error) {
            showMessage("adminMessage", error.message, "danger");
        }
    });
}

document.addEventListener("DOMContentLoaded", () => {
    initLogoutLinks();
    initNotificationModal();
    setupAuthNav();
    initRegister();
    initForgotPassword();
    initLogin();
    initAdminLogin();
    initDashboard();
    initNotificationPage();
    loadMembers();
    initUpdateForm();
    initUploadForm();
    initAdminPanel();
});

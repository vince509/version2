(() => {
    "use strict";

    const state = {
        papers: [],
        user: null,
        setupRequired: false,
        googleEnabled: false,
        directUploads: false,
        passwordSignupEnabled: true,
        query: "",
        users: [],
        authMode: "login",
        assistant: {
            busy: false,
            lastResults: []
        },
        toastTimer: null,
        inactivityTimer: null,
        lastActivitySync: 0
    };
    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
    async function apiRequest(url, options = {}) {
        let response;
        try {
            response = await fetch(url, options);
        } catch {
            throw new Error("The Research Hub server could not be reached. Please try again shortly.");
        }

        let result = {};
        if (response.status !== 204) {
            try {
                result = await response.json();
            } catch {
                throw new Error("The local server returned an invalid response.");
            }
        }
        if (!response.ok) {
            const error = new Error(result.error || `Request failed (${response.status}).`);
            error.status = response.status;
            throw error;
        }
        return result;
    }

    function showToast(message) {
        const toast = $("#toast");
        toast.textContent = message;
        toast.hidden = false;
        window.clearTimeout(state.toastTimer);
        state.toastTimer = window.setTimeout(() => {
            toast.hidden = true;
        }, 5000);
    }

    function showFormError(element, error) {
        element.textContent = error.message || "Something went wrong. Please try again.";
    }

    function escapeHTML(value) {
        return String(value).replace(/[&<>"']/g, (character) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[character]);
    }

    function normalize(value) {
        return String(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
    }

    function tokenize(value) {
        return normalize(value).split(/\s+/).filter((word) =>
            word.length > 1 && !["the", "and", "for", "with", "about", "from", "find", "show", "what", "are", "how", "can", "papers", "paper", "research", "please"].includes(word)
        );
    }

    function relatedTerms(query) {
        const normalized = normalize(query);
        const groups = [
            ["artificial intelligence", "ai", "machine learning", "generative ai"],
            ["student learning", "learning outcomes", "academic performance", "grades"],
            ["mobile application", "mobile app", "smartphone app"],
            ["information systems", "information system", "web-based system"],
            ["repository", "digital library", "research archive"]
        ];
        return [...new Set([
            normalized,
            ...groups.filter((group) => group.some((term) => normalized.includes(normalize(term)) || tokenize(normalized).includes(normalize(term))))
                .flatMap((group) => group.map(normalize))
        ])];
    }

    function scorePaper(paper, query) {
        const fields = [
            { text: normalize(paper.title), weight: 4 },
            { text: normalize(paper.topic), weight: 3 },
            { text: normalize(paper.author), weight: 2 },
            { text: normalize(paper.course), weight: 2 },
            { text: normalize(paper.department), weight: 1 },
            { text: normalize(paper.abstract), weight: 1 }
        ];
        const scores = relatedTerms(query).map((phrase) => {
            const words = tokenize(phrase);
            const wordScore = words.reduce((sum, word) => sum + fields.reduce(
                (fieldSum, field) => fieldSum + (field.text.includes(word) ? field.weight : 0),
                0
            ), 0);
            const phraseScore = fields.reduce(
                (sum, field) => sum + (phrase.length > 3 && field.text.includes(phrase) ? field.weight * 2 : 0),
                0
            );
            return wordScore + phraseScore;
        });
        return Math.max(0, ...scores);
    }

    function populateFilters() {
        const topicSelect = $("#topic-filter");
        const courseSelect = $("#course-filter");
        const selectedTopic = topicSelect.value || "all";
        const selectedCourse = courseSelect.value || "all";
        const topics = [...new Set(state.papers.map((paper) => paper.topic).filter(Boolean))].sort();
        const courses = [...new Set(state.papers.map((paper) => paper.course).filter(Boolean))].sort();
        topicSelect.innerHTML = '<option value="all">All topics</option>' +
            topics.map((topic) => `<option value="${escapeHTML(topic)}">${escapeHTML(topic)}</option>`).join("");
        courseSelect.innerHTML = '<option value="all">All courses</option>' +
            courses.map((course) => `<option value="${escapeHTML(course)}">${escapeHTML(course)}</option>`).join("");
        topicSelect.value = topics.includes(selectedTopic) ? selectedTopic : "all";
        courseSelect.value = courses.includes(selectedCourse) ? selectedCourse : "all";
    }

    function visiblePapers(query = state.query) {
        const topic = $("#topic-filter").value || "all";
        const course = $("#course-filter").value || "all";
        return state.papers.filter((paper) =>
            (topic === "all" || paper.topic === topic) &&
            (course === "all" || paper.course === course) &&
            (!query || scorePaper(paper, query) > 0)
        ).sort((first, second) => query
            ? scorePaper(second, query) - scorePaper(first, query) || second.year - first.year
            : second.year - first.year || first.title.localeCompare(second.title));
    }

    function renderPapers() {
        const papers = visiblePapers();
        $("#paper-count").textContent = String(state.papers.length);
        $("#result-count").textContent =
            `${papers.length} ${papers.length === 1 ? "paper" : "papers"}` +
            (state.query ? ` matching “${state.query}”` : "");
        $("#empty-state").hidden = papers.length > 0;
        $("#document-list").innerHTML = papers.map((paper) => `
            <article class="paper-row">
                <span class="file-mark" aria-label="${escapeHTML(paper.fileName.split(".").pop().toUpperCase())} document">${escapeHTML(paper.fileName.split(".").pop().toUpperCase())}</span>
                <div class="paper-main">
                    <h3>${escapeHTML(paper.title)}</h3>
                    <p class="paper-meta">${escapeHTML(paper.author)} · ${escapeHTML(paper.year)} · ${escapeHTML(paper.course)}</p>
                    <div class="paper-tags"><span class="tag">${escapeHTML(paper.topic)}</span><span class="tag">${escapeHTML(paper.department)}</span></div>
                </div>
                <div class="paper-actions">
                    <button class="icon-button" type="button" data-action="preview" data-id="${escapeHTML(paper.id)}" aria-label="Preview ${escapeHTML(paper.title)}" title="Preview abstract">↗</button>
                    <button class="icon-button" type="button" data-action="download" data-id="${escapeHTML(paper.id)}" aria-label="Download ${escapeHTML(paper.title)}" title="Download paper">↓</button>
                    ${state.user && ["Faculty", "Admin"].includes(state.user.role) ? `
                        <button class="icon-button" type="button" data-action="edit" data-id="${escapeHTML(paper.id)}" aria-label="Edit ${escapeHTML(paper.title)}" title="Edit paper">✎</button>
                        <button class="icon-button" type="button" data-action="delete" data-id="${escapeHTML(paper.id)}" aria-label="Delete ${escapeHTML(paper.title)}" title="Delete paper">×</button>` : ""}
                </div>
            </article>`).join("");
    }

    async function refreshPapers() {
        const response = await apiRequest("/api/papers");
        state.papers = response.papers;
        populateFilters();
        renderPapers();
    }

    function canManagePapers() {
        return state.user && ["Faculty", "Admin"].includes(state.user.role);
    }

    function canSubmitPapers() {
        return Boolean(state.user);
    }

    function updateAccountUI() {
        const button = $("#login-button");
        const label = $("#current-user");
        const upload = $("#upload-button");
        if (state.user) {
            button.textContent = "Sign out";
            label.textContent = `${state.user.username} · ${state.user.role}`;
            label.hidden = false;
            $("#users-button").hidden = state.user.role !== "Admin";
            $("#review-button").hidden = state.user.role !== "Admin";
            $("#submissions-button").hidden = state.user.role !== "Student";
            upload.disabled = !canSubmitPapers();
            upload.textContent = state.user.role === "Student" ? "＋ Submit a paper" : "＋ Add a paper";
            upload.title = state.user.role === "Student"
                ? "Submit a paper for Admin review"
                : "Add a document to the local library";
        } else {
            state.papers = [];
            state.assistant.lastResults = [];
            state.query = "";
            $("#search-input").value = "";
            populateFilters();
            $("#chat-messages").innerHTML = '<div class="chat-bubble assistant-bubble">Hi! I can search the papers in your local library, summarize saved abstracts, and compare research records. Try asking “Find research about online learning.”</div>';
            $$("dialog").filter((dialog) => dialog.id !== "login-modal" && dialog.open)
                .forEach((dialog) => dialog.close());
            button.textContent = "Log in";
            label.hidden = true;
            $("#users-button").hidden = true;
            $("#review-button").hidden = true;
            $("#submissions-button").hidden = true;
            upload.disabled = true;
            upload.textContent = "＋ Add a paper";
            upload.title = "Log in to submit or add a paper";
            document.body.classList.add("auth-locked");
        }
        if (state.user) document.body.classList.remove("auth-locked");
        renderPapers();
    }

    function setAuthMode(mode) {
        state.authMode = mode;
        const signup = mode === "signup";
        $("#login-title").textContent = signup ? "Create an account" : "Log in";
        $("#login-help").textContent = state.setupRequired
            ? "No accounts exist yet. The first account created becomes the local Admin."
            : signup
                ? "New accounts start as Students. Students can submit papers to the Admin for review."
                : "Sign in to your personal local library account.";
        $("#login-form button[type='submit']").textContent = signup ? "Create account" : "Continue";
        $("#auth-switch").innerHTML = signup
            ? 'Already registered? <button class="text-link" id="auth-switch-button" type="button">Log in</button>'
            : 'New here? <button class="text-link" id="auth-switch-button" type="button">Create an account</button>';
        $("#auth-switch").hidden = !state.passwordSignupEnabled;
        $("#auth-switch-button").addEventListener("click", () => {
            setAuthMode(signup ? "login" : "signup");
        });
        $("#forgot-password").hidden = signup || state.setupRequired;
        $("#login-message").textContent = "";
        $("#login-password").autocomplete = signup ? "new-password" : "current-password";
    }

    function showAuthRedirectMessage() {
        const params = new URLSearchParams(window.location.search);
        const authMessage = params.get("auth") === "google" ? "Signed in with Google." : "";
        const errors = {
            google_not_configured: "Google sign-in has not been configured yet.",
            google_public_url_required: "Open the private HTTPS Tailscale address to use Google sign-in.",
            google_state: "Google sign-in expired or could not be verified. Please try again.",
            google_cancelled: "Google sign-in was cancelled.",
            google_account_exists: "That Google email is already linked to a password account. Sign in with that account first or ask the Admin for help.",
            google_failed: "Google sign-in could not be completed. Please try again."
        };
        const errorMessage = errors[params.get("authError")] || "";
        if (authMessage || errorMessage) {
            window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
            showToast(authMessage || errorMessage);
        }
    }

    function openAuth(mode = "login") {
        setAuthMode(mode);
        $("#login-modal").showModal();
        $("#login-username").focus();
    }

    function updateActivity() {
        if (!state.user) return;
        window.clearTimeout(state.inactivityTimer);
        if (Date.now() - state.lastActivitySync >= 60 * 1000) {
            state.lastActivitySync = Date.now();
            void apiRequest("/api/session").then((result) => {
                if (state.user && result.user) {
                    state.user = result.user;
                    $("#current-user").textContent = `${result.user.username} · ${result.user.role}`;
                }
            }).catch((error) => {
                if (error.status === 401) {
                    state.user = null;
                    updateAccountUI();
                    openAuth("login");
                    showToast("Your session expired. Please log in again.");
                } else {
                    showToast(error.message);
                }
            });
        }
        state.inactivityTimer = window.setTimeout(async () => {
            try {
                await apiRequest("/api/auth/logout", { method: "POST" });
            } catch {
                // The server also expires inactive sessions.
            }
            state.user = null;
            updateAccountUI();
            openAuth("login");
            showToast("You were signed out after 15 minutes of inactivity.");
        }, 15 * 60 * 1000);
    }

    async function signOut() {
        try {
            await apiRequest("/api/auth/logout", { method: "POST" });
        } catch (error) {
            if (error.status !== 401) {
                showToast(error.message);
            }
        }
        window.clearTimeout(state.inactivityTimer);
        state.user = null;
        updateAccountUI();
        openAuth("login");
        showToast("You have signed out.");
    }

    function showPaperPreview(paper) {
        $("#paper-modal-kicker").textContent = paper.topic.toLocaleUpperCase();
        $("#paper-modal-title").textContent = paper.title;
        $("#paper-modal-body").innerHTML = `
            <p class="paper-detail-meta"><strong>Author(s):</strong> ${escapeHTML(paper.author)}<br>
            <strong>Year:</strong> ${escapeHTML(paper.year)}<br>
            <strong>Course:</strong> ${escapeHTML(paper.course)}<br>
            <strong>Department:</strong> ${escapeHTML(paper.department)}<br>
            <strong>Document:</strong> ${escapeHTML(paper.fileName)}</p>
            <h3>Abstract</h3>
            <p class="paper-detail-abstract">${escapeHTML(paper.abstract)}</p>
            <div class="paper-detail-actions">
                <button class="button" type="button" data-action="download" data-id="${escapeHTML(paper.id)}">↓ Download document</button>
                ${canManagePapers() ? `<button class="button button-light" type="button" data-action="edit" data-id="${escapeHTML(paper.id)}">Edit details</button>` : ""}
            </div>`;
        $("#paper-modal").showModal();
    }

    function rankedPapers(query, limit = 3) {
        return state.papers.map((paper) => ({ paper, score: scorePaper(paper, query) }))
            .filter((entry) => entry.score > 0)
            .sort((first, second) => second.score - first.score)
            .slice(0, limit)
            .map((entry) => entry.paper);
    }

    function selectedPaper(question, fallback) {
        const indexMatch = normalize(question).match(/\b(second|2nd|two|last|third|3rd|first|1st|top|one)\b/);
        if (indexMatch && /second|2nd|two/.test(indexMatch[0])) return fallback[1] || fallback[0];
        if (indexMatch && /third|3rd/.test(indexMatch[0])) return fallback[2] || fallback[0];
        return fallback[0];
    }

    function createFreeAnswer(question) {
        const normalized = normalize(question);
        const greeting = /^(hi|hello|hey|good morning|good afternoon|good evening|how are you)\b/.test(normalized);
        const help = /\b(help|what can you do|how do i use)\b/.test(normalized);
        const compare = /\b(compare|comparison|difference|differences|versus|vs)\b/.test(normalized);
        const summarize = /\b(summarize|summary|summarise|explain|abstract|details|detail|tell me more|more about)\b/.test(normalized);

        if (greeting) {
            const reply = normalized.startsWith("how are you")
                ? "I'm doing well, thanks for asking! I can help you explore the papers in this local library. What topic interests you?"
                : "Hello! I can search your library, summarize saved abstracts, or compare papers. What would you like to explore?";
            return { text: reply, papers: [] };
        }
        if (/\b(thank you|thanks)\b/.test(normalized)) {
            return { text: "You're welcome! Ask me about a topic or a paper whenever you're ready.", papers: [] };
        }
        if (help) {
            return {
                text: "I can search this computer's paper catalog, show matching results, summarize their saved abstracts, and compare the catalog records. Try asking about a topic, or first upload papers and abstracts to the library.",
                papers: []
            };
        }
        if (!state.papers.length) {
            return { text: "Your research library is empty, so I don't have papers to search yet. A Faculty or Admin account can add a paper and its abstract; then I can find it here.", papers: [] };
        }

        const contextWords = /\b(first|second|third|top|this|that|these|those|it|them|above|same)\b/.test(normalized);
        let results = contextWords && state.assistant.lastResults.length
            ? state.assistant.lastResults
            : rankedPapers(question, compare ? 6 : 3);
        if (compare && results.length < 2) results = rankedPapers(question, 6);
        if (!results.length) {
            return { text: "I couldn't find a matching title, topic, author, course, or abstract in your saved library. Try a broader keyword, or upload more papers.", papers: [] };
        }

        if (summarize) {
            const paper = selectedPaper(question, results);
            state.assistant.lastResults = results;
            state.query = paper.title;
            $("#search-input").value = paper.title;
            renderPapers();
            return { text: `Here is the abstract for “${paper.title}” (${paper.year}):\n\n${paper.abstract}\n\nThis uses the abstract stored with the paper.`, papers: [paper] };
        }
        if (compare && results.length >= 2) {
            const first = selectedPaper(question, results);
            const second = results.find((paper) => paper.id !== first.id) || results[1];
            state.assistant.lastResults = [first, second, ...results.filter((paper) => paper.id !== first.id && paper.id !== second.id)];
            return {
                text: `Here is a catalog-level comparison:\n\n${first.title} (${first.year}) — ${first.topic}. ${first.abstract}\n\n${second.title} (${second.year}) — ${second.topic}. ${second.abstract}\n\nI can compare only the saved catalog details and abstracts.`,
                papers: [first, second]
            };
        }

        state.assistant.lastResults = results;
        state.query = question;
        $("#search-input").value = question;
        renderPapers();
        return {
            text: `I found ${results.length} ${results.length === 1 ? "paper" : "papers"} that may be relevant. I ranked them by matching words in their title, topic, course, author, and abstract. Choose a result below to read its details.`,
            papers: results
        };
    }

    function scrollChatToBottom() {
        const messages = $("#chat-messages");
        messages.scrollTop = messages.scrollHeight;
    }

    function addChatMessage(text, type = "assistant", papers = []) {
        const bubble = document.createElement("div");
        bubble.className = `chat-bubble ${type === "user" ? "user-bubble" : "assistant-bubble"}`;
        bubble.textContent = text;
        if (papers.length) {
            const results = document.createElement("div");
            results.className = "chat-result-list";
            for (const paper of papers) {
                const button = document.createElement("button");
                button.className = "chat-result";
                button.type = "button";
                button.dataset.chatPaperId = String(paper.id);
                const title = document.createElement("strong");
                title.textContent = paper.title;
                const details = document.createElement("span");
                details.textContent = `${paper.topic} · ${paper.year} · Select to preview`;
                button.append(title, details);
                results.append(button);
            }
            bubble.append(results);
        }
        $("#chat-messages").append(bubble);
        scrollChatToBottom();
    }

    function updateChatSuggestions() {
        $("#chat-suggestions").innerHTML = [
            { label: "Search this library", question: "Find papers about " },
            { label: "Summarize a result", question: "Summarize the first paper" },
            { label: "Compare results", question: "Compare the first two papers" }
        ].map((suggestion) =>
            `<button class="suggestion" type="button" data-question="${escapeHTML(suggestion.question)}">${escapeHTML(suggestion.label)}</button>`
        ).join("");
    }

    async function askAssistant(question) {
        if (state.assistant.busy) return;
        state.assistant.busy = true;
        addChatMessage(question, "user");
        const sendButton = $("#chat-form button[type='submit']");
        sendButton.disabled = true;
        $("#chat-input").disabled = true;
        const typing = document.createElement("div");
        typing.className = "chat-bubble assistant-bubble chat-typing";
        typing.setAttribute("aria-label", "Searching the local library");
        typing.innerHTML = "<span></span><span></span><span></span>";
        $("#chat-messages").append(typing);
        scrollChatToBottom();
        try {
            await new Promise((resolve) => window.setTimeout(resolve, 180));
            const answer = createFreeAnswer(question);
            typing.remove();
            addChatMessage(answer.text, "assistant", answer.papers);
            updateChatSuggestions();
        } catch (error) {
            typing.remove();
            addChatMessage(`I couldn't search the library: ${error.message}`);
        } finally {
            state.assistant.busy = false;
            sendButton.disabled = false;
            $("#chat-input").disabled = false;
            $("#chat-input").focus();
        }
    }

    function openPaperForm(paper = null) {
        if (!canSubmitPapers() || (paper && !canManagePapers())) {
            showToast("Sign in to submit a paper. Student submissions are reviewed by an Admin.");
            return;
        }
        const form = $("#paper-form");
        form.reset();
        $("#paper-id").value = paper ? paper.id : "";
        const studentSubmission = state.user.role === "Student";
        $("#paper-form-title").textContent = paper ? "Edit paper details" : studentSubmission ? "Submit a research paper" : "Add a research paper";
        $("#paper-submit-button").textContent = studentSubmission ? "Submit for review" : "Save paper";
        $("#paper-form .modal-explanation").textContent = studentSubmission
            ? "Your paper and document will be sent to the local Admin for review before appearing in the library."
            : state.directUploads
                ? "PDF, DOCX, and TXT files are saved in private cloud storage (10 MB maximum)."
                : "PDF, DOCX, and TXT files are saved in the local research library on this computer (10 MB maximum).";
        $("#paper-title").value = paper ? paper.title : "";
        $("#paper-author").value = paper ? paper.author : "";
        $("#paper-year").value = paper ? paper.year : new Date().getFullYear();
        $("#paper-topic").value = paper ? paper.topic : "";
        $("#paper-course").value = paper ? paper.course : "";
        $("#paper-department").value = paper ? paper.department : "";
        $("#paper-abstract").value = paper ? paper.abstract : "";
        $("#paper-file").required = !paper;
        $("#file-help").textContent = paper
            ? `Current document: ${paper.fileName}. Choose a replacement if needed.`
            : state.directUploads
                ? "Select a PDF, DOCX, or TXT file to store privately in cloud storage (maximum 10 MB)."
                : "Select an actual PDF, DOCX, or TXT file (maximum 10 MB).";
        $("#paper-form-message").textContent = "";
        $("#paper-form-modal").showModal();
    }

    async function handlePaperAction(action, id) {
        const paper = state.papers.find((item) => String(item.id) === String(id));
        if (!paper) {
            showToast("That paper is no longer in the library.");
            await refreshPapers();
            return;
        }
        if (action === "preview") {
            showPaperPreview(paper);
            return;
        }
        if (action === "download") {
            if (!state.user) {
                openAuth("login");
                $("#login-message").textContent = "Sign in before downloading a protected document.";
                return;
            }
            const link = document.createElement("a");
            link.href = `/api/papers/${encodeURIComponent(paper.id)}/download`;
            link.download = paper.fileName;
            document.body.append(link);
            link.click();
            link.remove();
            return;
        }
        if (action === "edit") {
            openPaperForm(paper);
            return;
        }
        if (action === "delete") {
            if (!canManagePapers()) {
                showToast("A Faculty or Admin account is required to delete papers.");
                return;
            }
            if (!window.confirm(`Permanently delete “${paper.title}” and its document from this computer?`)) return;
            try {
                await apiRequest(`/api/papers/${encodeURIComponent(paper.id)}`, { method: "DELETE" });
                await refreshPapers();
                showToast("Paper and stored document deleted.");
            } catch (error) {
                showToast(error.message);
            }
        }
    }

    async function loadUsers() {
        const response = await apiRequest("/api/users");
        state.users = response.users;
        renderUsers();
    }

    function submissionMarkup(paper, actions = "") {
        const status = paper.status;
        return `
            <article class="submission-row">
                <div>
                    <strong>${escapeHTML(paper.title)}</strong>
                    <p>${escapeHTML(paper.author)} · ${escapeHTML(paper.year)} · ${escapeHTML(paper.course)}</p>
                    ${paper.submittedBy ? `<p>Submitted by ${escapeHTML(paper.submittedBy)}</p>` : ""}
                    ${paper.abstract && status === "pending" ? `<p class="submission-abstract">${escapeHTML(paper.abstract)}</p>` : ""}
                    <span class="submission-status status-${escapeHTML(status)}">${escapeHTML(status[0].toUpperCase() + status.slice(1))}</span>
                </div>
                ${actions}
            </article>`;
    }

    async function loadPendingSubmissions() {
        const response = await apiRequest("/api/papers/pending");
        $("#pending-list").innerHTML = response.papers.length
            ? response.papers.map((paper) => submissionMarkup(paper, `
                <div class="submission-actions">
                    <a class="button button-light" href="/api/papers/${encodeURIComponent(paper.id)}/review-download" download="${escapeHTML(paper.fileName)}">Download document</a>
                    <button class="button" type="button" data-review-status="approved" data-id="${escapeHTML(paper.id)}">Approve</button>
                    <button class="button button-light" type="button" data-review-status="rejected" data-id="${escapeHTML(paper.id)}">Reject</button>
                </div>`)).join("")
            : '<p class="empty-state">There are no student submissions waiting for review.</p>';
    }

    async function loadMySubmissions() {
        const response = await apiRequest("/api/my-submissions");
        $("#my-submissions-list").innerHTML = response.submissions.length
            ? response.submissions.map((paper) => submissionMarkup(paper)).join("")
            : '<p class="empty-state">You have not submitted any papers yet.</p>';
    }

    function renderUsers() {
        $("#user-list").innerHTML = state.users.map((user) => `
            <form class="user-row" data-user-id="${escapeHTML(user.id)}">
                <input class="user-name-input" name="username" value="${escapeHTML(user.username)}" minlength="3" maxlength="32" required aria-label="Username for ${escapeHTML(user.username)}">
                <div class="user-row-actions">
                    <input type="password" name="password" minlength="10" autocomplete="new-password" placeholder="New password (optional)" aria-label="New password for ${escapeHTML(user.username)}">
                    <label class="sr-only" for="user-role-${escapeHTML(user.id)}">Role for ${escapeHTML(user.username)}</label>
                    <select id="user-role-${escapeHTML(user.id)}" name="role" aria-label="Role for ${escapeHTML(user.username)}">
                        ${["Student", "Faculty", "Admin"].map((role) => `<option value="${role}"${role === user.role ? " selected" : ""}>${role}</option>`).join("")}
                    </select>
                    <button class="icon-button" type="submit" aria-label="Save ${escapeHTML(user.username)}">✓</button>
                    <button class="icon-button" type="button" data-delete-user aria-label="Delete ${escapeHTML(user.username)}">×</button>
                </div>
            </form>`).join("");
    }

    function openLoginForRoleError(error) {
        if (error.status === 401) {
            openAuth("login");
            $("#login-message").textContent = "Please sign in to continue.";
            return true;
        }
        if (error.status === 403) {
            showToast("Your account does not have permission to do that.");
            return true;
        }
        return false;
    }

    function initializeEvents() {
        $("#search-form").addEventListener("submit", (event) => {
            event.preventDefault();
            state.query = $("#search-input").value.trim();
            renderPapers();
        });
        $("#search-input").addEventListener("input", () => {
            if (!$("#search-input").value.trim()) {
                state.query = "";
                renderPapers();
            }
        });
        $("#topic-filter").addEventListener("change", renderPapers);
        $("#course-filter").addEventListener("change", renderPapers);
        $$("[data-query]").forEach((button) => button.addEventListener("click", () => {
            state.query = button.dataset.query;
            $("#search-input").value = state.query;
            renderPapers();
            $("#repository").scrollIntoView({ behavior: "smooth" });
        }));
        $("#document-list").addEventListener("click", (event) => {
            const button = event.target.closest("[data-action]");
            if (button) void handlePaperAction(button.dataset.action, button.dataset.id);
        });
        $("#paper-modal-body").addEventListener("click", (event) => {
            const button = event.target.closest("[data-action]");
            if (button) void handlePaperAction(button.dataset.action, button.dataset.id);
        });
        $("#chat-messages").addEventListener("click", (event) => {
            const button = event.target.closest("[data-chat-paper-id]");
            const paper = state.papers.find((item) => String(item.id) === button?.dataset.chatPaperId);
            if (paper) showPaperPreview(paper);
        });
        $("#chat-form").addEventListener("submit", (event) => {
            event.preventDefault();
            const question = $("#chat-input").value.trim();
            if (question) {
                void askAssistant(question);
                $("#chat-input").value = "";
            }
        });
        $("#chat-suggestions").addEventListener("click", (event) => {
            const button = event.target.closest("[data-question]");
            if (button) {
                const question = button.dataset.question === "Find papers about "
                    ? window.prompt("Which topic would you like to search?")
                    : button.dataset.question;
                if (question) void askAssistant(question);
            }
        });

        $("#login-button").addEventListener("click", () => {
            if (state.user) void signOut();
            else openAuth("login");
        });
        $("#google-login-button").addEventListener("click", (event) => {
            if (!state.googleEnabled) event.preventDefault();
        });
        $("#auth-switch-button").addEventListener("click", () => {
            setAuthMode(state.authMode === "login" ? "signup" : "login");
        });
        $("#forgot-password").addEventListener("click", () => {
            $("#login-message").textContent = "Ask the local Admin to change your account password in Manage accounts.";
        });
        $("#login-form").addEventListener("submit", async (event) => {
            event.preventDefault();
            if (!event.currentTarget.reportValidity()) return;
            const submit = $("#login-form button[type='submit']");
            submit.disabled = true;
            $("#login-message").textContent = "";
            try {
                const endpoint = state.authMode === "signup" ? "/api/auth/register" : "/api/auth/login";
                const result = await apiRequest(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        username: $("#login-username").value.trim(),
                        password: $("#login-password").value,
                        remember: $("#remember-login").checked
                    })
                });
                const papers = await apiRequest("/api/papers");
                state.papers = papers.papers;
                populateFilters();
                state.user = result.user;
                state.setupRequired = false;
                $("#login-modal").close();
                state.lastActivitySync = Date.now();
                updateAccountUI();
                updateActivity();
                showToast(result.firstAccount
                    ? "Local Admin account created. You can now assign Faculty roles."
                    : state.authMode === "signup"
                        ? "Account created with Student access."
                        : `Signed in as ${state.user.role}.`);
            } catch (error) {
                if (error.status === 401) {
                    $("#login-message").textContent = "Incorrect username or password.";
                } else {
                    showFormError($("#login-message"), error);
                }
            } finally {
                submit.disabled = false;
            }
        });

        $("#upload-button").addEventListener("click", () => openPaperForm());
        $("#paper-form").addEventListener("submit", async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            if (!form.reportValidity()) return;
            const file = $("#paper-file").files[0];
            if (file && file.size > 10 * 1024 * 1024) {
                $("#paper-form-message").textContent = "Choose a document smaller than 10 MB.";
                return;
            }
            if (!$("#paper-id").value && !file) {
                $("#paper-form-message").textContent = "Choose the research document you want to upload.";
                return;
            }
            const id = $("#paper-id").value;
            const data = new FormData(form);
            data.delete("file");
            if (file) data.append("file", file);
            const submit = $("#paper-form button[type='submit']");
            submit.disabled = true;
            $("#paper-form-message").textContent = "Saving paper and document…";
            try {
                if (state.directUploads) {
                    const values = Object.fromEntries(data.entries());
                    if (file) {
                        const prepared = await apiRequest("/api/uploads/prepare", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ fileName: file.name, size: file.size })
                        });
                        let uploadResponse;
                        try {
                            uploadResponse = await fetch(prepared.url, {
                                method: "PUT",
                                headers: { "Content-Type": prepared.contentType },
                                body: file
                            });
                        } catch {
                            throw new Error("The secure file store could not be reached. Check the bucket CORS settings and try again.");
                        }
                        if (!uploadResponse.ok) {
                            throw new Error("The document could not be uploaded to secure storage. Please try again.");
                        }
                        values.objectKey = prepared.key;
                        values.fileName = prepared.fileName;
                    }
                    await apiRequest(id ? `/api/papers/${encodeURIComponent(id)}` : "/api/papers", {
                        method: id ? "PUT" : "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(values)
                    });
                } else {
                    await apiRequest(id ? `/api/papers/${encodeURIComponent(id)}` : "/api/papers", {
                        method: id ? "PUT" : "POST",
                        body: data
                    });
                }
                state.query = "";
                $("#search-input").value = "";
                $("#topic-filter").value = "all";
                $("#course-filter").value = "all";
                await refreshPapers();
                $("#paper-form-modal").close();
                const submission = !id && state.user.role === "Student";
                showToast(id
                    ? "Paper and document updated in the research library."
                    : submission
                        ? "Paper submitted. An Admin must approve it before it appears in the library."
                        : "Paper and document uploaded to the research library.");
            } catch (error) {
                if (!openLoginForRoleError(error)) showFormError($("#paper-form-message"), error);
            } finally {
                submit.disabled = false;
            }
        });

        $("#review-button").addEventListener("click", async () => {
            try {
                await loadPendingSubmissions();
                $("#review-modal").showModal();
            } catch (error) {
                if (!openLoginForRoleError(error)) showToast(error.message);
            }
        });
        $("#pending-list").addEventListener("click", async (event) => {
            const button = event.target.closest("[data-review-status]");
            if (!button) return;
            button.disabled = true;
            try {
                await apiRequest(`/api/papers/${encodeURIComponent(button.dataset.id)}/review`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ status: button.dataset.reviewStatus })
                });
                await Promise.all([loadPendingSubmissions(), refreshPapers()]);
                showToast(button.dataset.reviewStatus === "approved"
                    ? "Submission approved and published in the library."
                    : "Submission rejected and its document removed.");
            } catch (error) {
                button.disabled = false;
                if (!openLoginForRoleError(error)) showToast(error.message);
            }
        });
        $("#submissions-button").addEventListener("click", async () => {
            try {
                await loadMySubmissions();
                $("#submissions-modal").showModal();
            } catch (error) {
                if (!openLoginForRoleError(error)) showToast(error.message);
            }
        });

        $("#users-button").addEventListener("click", async () => {
            try {
                await loadUsers();
                $("#users-modal").showModal();
            } catch (error) {
                if (!openLoginForRoleError(error)) showToast(error.message);
            }
        });
        $("#user-form").addEventListener("submit", async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = {
                username: $("#new-username").value.trim(),
                password: $("#new-user-password").value,
                role: $("#new-user-role").value
            };
            try {
                await apiRequest("/api/users", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(data)
                });
                form.reset();
                await loadUsers();
                showToast("Account created.");
            } catch (error) {
                if (!openLoginForRoleError(error)) showToast(error.message);
            }
        });
        $("#user-list").addEventListener("submit", async (event) => {
            const form = event.target.closest("[data-user-id]");
            if (!form) return;
            event.preventDefault();
            const values = new FormData(form);
            const payload = {
                username: String(values.get("username")).trim(),
                role: String(values.get("role")),
                password: String(values.get("password") || "")
            };
            try {
                await apiRequest(`/api/users/${encodeURIComponent(form.dataset.userId)}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                await loadUsers();
                showToast("Account details saved.");
            } catch (error) {
                if (!openLoginForRoleError(error)) showToast(error.message);
            }
        });
        $("#user-list").addEventListener("click", async (event) => {
            const button = event.target.closest("[data-delete-user]");
            if (!button) return;
            const form = button.closest("[data-user-id]");
            const name = form.querySelector("[name='username']").value;
            if (!window.confirm(`Permanently delete the account “${name}”?`)) return;
            try {
                await apiRequest(`/api/users/${encodeURIComponent(form.dataset.userId)}`, { method: "DELETE" });
                await loadUsers();
                showToast("Account deleted.");
            } catch (error) {
                if (!openLoginForRoleError(error)) showToast(error.message);
            }
        });

        $$(".nav-link").forEach((link) => link.addEventListener("click", () => {
            $$(".nav-link").forEach((item) => item.classList.remove("active"));
            link.classList.add("active");
        }));
        $$("[data-close]").forEach((button) => button.addEventListener("click", () => {
            document.getElementById(button.dataset.close)?.close();
        }));
        $$("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
            if (event.target === dialog) dialog.close();
        }));
        document.addEventListener("pointerdown", updateActivity, { passive: true });
        document.addEventListener("keydown", updateActivity);
        $("#login-modal").addEventListener("cancel", (event) => {
            if (!state.user) event.preventDefault();
        });
        $("#login-modal").addEventListener("close", () => {
            $("#login-form").reset();
            if (!state.user) {
                window.setTimeout(() => openAuth(state.setupRequired ? "signup" : "login"), 0);
            }
        });
        $("#paper-form-modal").addEventListener("close", () => $("#paper-form").reset());
    }

    async function initialize() {
        initializeEvents();
        $("#upload-button").disabled = true;
        try {
            const [session, authConfig] = await Promise.all([
                apiRequest("/api/session"),
                apiRequest("/api/auth/config")
            ]);
            state.googleEnabled = authConfig.googleEnabled;
            state.directUploads = authConfig.directUploads;
            state.passwordSignupEnabled = authConfig.passwordSignupEnabled;
            $("#file-help").textContent = state.directUploads
                ? "Documents are stored in private cloud storage."
                : "Documents are stored on the computer running the server.";
            $("#google-login-button").hidden = !state.googleEnabled;
            $("#google-login-note").hidden = !state.googleEnabled;
            state.user = session.user;
            state.setupRequired = session.setupRequired;
            if (state.user) {
                const papers = await apiRequest("/api/papers");
                state.papers = papers.papers;
            }
            populateFilters();
            updateAccountUI();
            if (state.user) updateActivity();
            else openAuth(state.setupRequired ? "signup" : "login");
            showAuthRedirectMessage();
        } catch (error) {
            $("#result-count").textContent = "Library server is unavailable";
            $("#empty-state").hidden = false;
            $("#empty-state").textContent = error.message;
            showToast(error.message);
        }
    }

    void initialize();
})();

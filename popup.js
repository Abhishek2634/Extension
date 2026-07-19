const byId = (id) => document.getElementById(id);

const elements = {
  environment: byId("environment"),
  authCard: byId("auth-card"),
  authPanel: byId("auth-panel"),
  loginBtn: byId("login-btn"),
  logoutBtn: byId("logout-btn"),
  lookupStatus: byId("lookup-status"),
  matchPanel: byId("match-panel"),
  pageUrl: byId("page-url"),
  form: byId("paper-form"),
  title: byId("title"),
  doi: byId("doi"),
  pmid: byId("pmid"),
  arxivId: byId("arxiv_id"),
  authors: byId("authors"),
  abstract: byId("abstract"),
  url: byId("url"),
  addToCommunity: byId("add_to_community"),
  communitySection: byId("community-section"),
  communityName: byId("community_name"),
  saveBtn: byId("save-btn"),
  status: byId("status")
};

const state = {
  detectedPaper: null,
  authStatus: null,
  currentMatch: null,
  busy: null
};

const sendMessage = (message) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "SciCommons extension command failed."));
        return;
      }
      resolve(response.data);
    });
  });

const normalizeStatusClass = (baseClass, kind) => `${baseClass}${kind ? ` ${kind}` : ""}`;

const setStatus = (message, kind = "") => {
  elements.status.textContent = message;
  elements.status.className = normalizeStatusClass("status", kind);
};

const setLookupStatus = (message, kind = "") => {
  elements.lookupStatus.textContent = message;
  elements.lookupStatus.className = normalizeStatusClass("status-pill", kind);
};

const formatQueueText = (queueLength) => {
  if (!queueLength) return "";
  const noun = queueLength === 1 ? "save" : "saves";
  return ` ${queueLength} queued ${noun}.`;
};

const updateControls = () => {
  const isBusy = Boolean(state.busy);
  const isConnected = Boolean(state.authStatus?.connected);

  elements.loginBtn.disabled = isBusy;
  elements.logoutBtn.disabled = isBusy || !isConnected;
  elements.saveBtn.disabled = isBusy;
  elements.environment.disabled = isBusy;

  elements.loginBtn.textContent = state.busy === "login" ? "Connecting..." : isConnected ? "Reconnect" : "Connect";
  elements.saveBtn.textContent = state.busy === "save" ? "Saving..." : "Save to SciCommons";
};

const setBusy = (busyState) => {
  state.busy = busyState;
  updateControls();
};

const renderEnvironmentOptions = () => {
  const authStatus = state.authStatus;
  if (!authStatus?.environments) return;

  elements.environment.innerHTML = "";
  Object.entries(authStatus.environments).forEach(([key, config]) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = config.label;
    option.selected = key === authStatus.environmentKey;
    elements.environment.appendChild(option);
  });
};

const renderAuthStatus = () => {
  const authStatus = state.authStatus;
  if (!authStatus) return;

  elements.authCard.classList.toggle("connected", Boolean(authStatus.connected));
  elements.authPanel.textContent = authStatus.connected
    ? `Connected as ${authStatus.user?.username || "SciCommons user"}.${formatQueueText(authStatus.queueLength)}`
    : `Not connected.${formatQueueText(authStatus.queueLength)}`;

  updateControls();
};

const refreshAuthStatus = async () => {
  state.authStatus = await sendMessage({ type: "GET_AUTH_STATUS" });
  renderEnvironmentOptions();
  renderAuthStatus();
  return state.authStatus;
};

const getActiveTab = async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
};

const detectPaper = async () => {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab found.");

  const askContentScript = () =>
    new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, { type: "SCICOMMONS_DETECT_PAPER" }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          reject(new Error(chrome.runtime.lastError?.message || "Paper detection failed."));
          return;
        }
        resolve(response.paper);
      });
    });

  try {
    return await askContentScript();
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["contentScript.js"] });
    return askContentScript();
  }
};

const renderPaper = (paper) => {
  const authors = Array.isArray(paper?.authors) ? paper.authors.join(", ") : "";

  elements.title.value = paper?.title || "";
  elements.doi.value = paper?.doi || "";
  elements.pmid.value = paper?.pmid || "";
  elements.arxivId.value = paper?.arxiv_id || "";
  elements.authors.value = authors;
  elements.abstract.value = paper?.abstract || "";
  elements.url.value = paper?.url || "";
  elements.pageUrl.textContent = paper?.url || "";
  elements.pageUrl.title = paper?.url || "";
};

const renderMatch = (match) => {
  if (match?.found) {
    elements.matchPanel.classList.remove("hidden");
    elements.matchPanel.textContent = `Already on SciCommons: ${match.title}. Discussions: ${match.total_discussions}; reviews: ${match.total_reviews}.`;
    setLookupStatus("Match found", "success");
    return;
  }

  elements.matchPanel.classList.add("hidden");
  elements.matchPanel.textContent = "";
  setLookupStatus("No match yet");
};

const lookupDetectedPaper = async () => {
  if (!state.detectedPaper) return;

  setLookupStatus("Checking...");
  try {
    state.currentMatch = await sendMessage({ type: "LOOKUP_PAPER", paper: state.detectedPaper });
    renderMatch(state.currentMatch);
  } catch (error) {
    state.currentMatch = null;
    elements.matchPanel.classList.add("hidden");
    elements.matchPanel.textContent = "";
    setLookupStatus(error.message, "error");
  }
};

const parseAuthors = (value) =>
  value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ label: name, value: name }));

const buildImportPayload = () => ({
  title: elements.title.value.trim(),
  abstract: elements.abstract.value.trim(),
  authors: parseAuthors(elements.authors.value),
  doi: elements.doi.value.trim() || null,
  pmid: elements.pmid.value.trim() || null,
  arxiv_id: elements.arxivId.value.trim() || null,
  url: elements.url.value || state.detectedPaper?.url || null,
  canonical_url: elements.url.value || state.detectedPaper?.url || null,
  submission_type: "Public",
  community_name: elements.addToCommunity.checked ? elements.communityName.value.trim() : null,
  idempotency_key: crypto.randomUUID()
});

const openArticle = (articleUrl) => {
  if (articleUrl) chrome.tabs.create({ url: articleUrl });
};

const validatePayload = (payload) => {
  if (!payload.title) return "Title is required.";
  if (elements.addToCommunity.checked && !payload.community_name) return "Community name is required.";
  return "";
};

const connectExtension = async () => {
  setBusy("login");
  setStatus("Opening SciCommons login...");
  try {
    await sendMessage({ type: "LOGIN" });
    await refreshAuthStatus();
    await lookupDetectedPaper();
    setStatus("Extension connected.", "success");
  } finally {
    setBusy(null);
  }
};

const submitPaper = async (event) => {
  event.preventDefault();
  setStatus("");

  const payload = buildImportPayload();
  const validationError = validatePayload(payload);
  if (validationError) {
    setStatus(validationError, "error");
    return;
  }

  setBusy("save");
  try {
    if (!state.authStatus?.connected) {
      setStatus("Connect SciCommons before saving.");
      await sendMessage({ type: "LOGIN" });
      await refreshAuthStatus();
    }

    setStatus("Saving to SciCommons...");
    const response = await sendMessage({ type: "IMPORT_PAPER", payload });
    await refreshAuthStatus();

    if (response.queued) {
      setStatus("Save queued. It will retry when SciCommons is reachable.", "success");
      return;
    }

    setStatus("Saved to SciCommons.", "success");
    openArticle(response.result.article_url);
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(null);
  }
};

const toggleCommunityFields = () => {
  elements.communitySection.classList.toggle("hidden", !elements.addToCommunity.checked);
};

const initializePopup = async () => {
  setLookupStatus("Detecting...");
  updateControls();

  try {
    await refreshAuthStatus();
    state.detectedPaper = await detectPaper();
    renderPaper(state.detectedPaper);
    await lookupDetectedPaper();
  } catch (error) {
    setLookupStatus(error.message, "error");
  }
};

document.addEventListener("DOMContentLoaded", initializePopup);

elements.environment.addEventListener("change", async () => {
  setBusy("environment");
  try {
    await sendMessage({
      type: "SET_ENVIRONMENT",
      environmentKey: elements.environment.value
    });
    await refreshAuthStatus();
    await lookupDetectedPaper();
    setStatus("Environment changed. Reconnect before saving.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(null);
  }
});

elements.loginBtn.addEventListener("click", async () => {
  try {
    await connectExtension();
  } catch (error) {
    setStatus(error.message, "error");
  }
});

elements.logoutBtn.addEventListener("click", async () => {
  setBusy("logout");
  try {
    await sendMessage({ type: "LOGOUT" });
    await refreshAuthStatus();
    setStatus("Extension disconnected.");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(null);
  }
});

elements.addToCommunity.addEventListener("change", toggleCommunityFields);
elements.form.addEventListener("submit", submitPaper);

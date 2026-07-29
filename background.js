importScripts("config.js");

const STORAGE_KEYS = {
  environment: "scicommonsEnvironment",
  auth: "scicommonsAuth",
  offlineQueue: "scicommonsOfflineQueue"
};

const CLIENT_ID = "scicommons-clipper";
const RETRY_ALARM = "scicommonsRetryQueue";

const storageGet = (keys) => chrome.storage.local.get(keys);
const storageSet = (values) => chrome.storage.local.set(values);
const storageRemove = (keys) => chrome.storage.local.remove(keys);

const base64UrlEncode = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const randomString = (bytes = 32) => {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64UrlEncode(data);
};

const sha256Challenge = async (verifier) => {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64UrlEncode(digest);
};

const getEnvironmentKey = async () => {
  const stored = await storageGet({ [STORAGE_KEYS.environment]: SCICOMMONS_DEFAULT_ENVIRONMENT });
  const key = stored[STORAGE_KEYS.environment];
  return SCICOMMONS_ENVIRONMENTS[key] ? key : SCICOMMONS_DEFAULT_ENVIRONMENT;
};

const getConfig = async () => {
  const environmentKey = await getEnvironmentKey();
  return {
    environmentKey,
    ...SCICOMMONS_ENVIRONMENTS[environmentKey]
  };
};

const normalizeBaseUrl = (url) => url.replace(/\/+$/, "");

const normalizeText = (value) =>
  String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeDoi = (value) =>
  normalizeText(value)
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[.,;)\]]+$/, "")
    .trim();

const formatCrossrefAuthor = (author) => {
  if (!author || typeof author !== "object") return "";
  return normalizeText(author.name || [author.given, author.family].filter(Boolean).join(" "));
};

const normalizeCrossrefMetadata = (message = {}) => ({
  title: normalizeText(Array.isArray(message.title) ? message.title[0] : message.title),
  abstract: normalizeText(message.abstract),
  authors: Array.isArray(message.author) ? message.author.map(formatCrossrefAuthor).filter(Boolean) : [],
  doi: normalizeDoi(message.DOI),
  url: normalizeText(message.URL)
});

const crossrefErrorMessage = (payload, fallback) => {
  const message = payload?.message;
  if (typeof message === "string") return message;
  if (Array.isArray(message) && message[0]?.message) return message[0].message;
  return fallback;
};

const fetchCrossrefMetadata = async (doi) => {
  const normalizedDoi = normalizeDoi(doi);
  if (!normalizedDoi) {
    throw new Error("A DOI is required for CrossRef lookup.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(normalizedDoi)}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new Error(crossrefErrorMessage(payload, `CrossRef request failed (${response.status}).`));
    }

    return normalizeCrossrefMetadata(payload?.message || {});
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("CrossRef metadata request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

const getAuth = async () => {
  const stored = await storageGet({ [STORAGE_KEYS.auth]: null });
  return stored[STORAGE_KEYS.auth];
};

const setAuth = (auth) => storageSet({ [STORAGE_KEYS.auth]: auth });

const apiFetch = async (path, options = {}, requireAuth = true) => {
  const config = await getConfig();
  const headers = new Headers(options.headers || {});
  const auth = await getAuth();

  if (requireAuth) {
    if (!auth?.access_token) {
      const error = new Error("Please connect the SciCommons extension first.");
      error.authRequired = true;
      throw error;
    }
    headers.set("Authorization", `Bearer ${auth.access_token}`);
  }

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${normalizeBaseUrl(config.apiBaseUrl)}${path}`, {
    ...options,
    headers
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.message || `SciCommons request failed (${response.status}).`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
};

const launchWebAuthFlow = (url) =>
  new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (responseUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!responseUrl) {
        reject(new Error("SciCommons login did not return an authorization code."));
        return;
      }
      resolve(responseUrl);
    });
  });

const login = async () => {
  const config = await getConfig();
  const redirectUri = chrome.identity.getRedirectURL("scicommons");
  const state = randomString(24);
  const codeVerifier = randomString(64);
  const codeChallenge = await sha256Challenge(codeVerifier);
  const authUrl = new URL(`${normalizeBaseUrl(config.frontendBaseUrl)}/auth/extension`);

  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const responseUrl = await launchWebAuthFlow(authUrl.toString());
  const callbackUrl = new URL(responseUrl);
  const returnedState = callbackUrl.searchParams.get("state");
  const code = callbackUrl.searchParams.get("code");

  if (!code || returnedState !== state) {
    throw new Error("SciCommons login returned an invalid authorization response.");
  }

  const tokenPayload = await apiFetch(
    "/api/integrations/extension/exchange",
    {
      method: "POST",
      body: JSON.stringify({
        client_id: CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri
      })
    },
    false
  );

  const auth = {
    ...tokenPayload,
    connected_at: Date.now(),
    environment: config.environmentKey
  };
  await setAuth(auth);
  await retryQueue();
  return auth;
};

const lookupPaper = async (paper) => {
  const params = new URLSearchParams();
  if (paper?.doi) params.set("doi", paper.doi);
  if (paper?.pmid) params.set("pmid", paper.pmid);
  if (paper?.arxiv_id) params.set("arxiv_id", paper.arxiv_id);
  if (paper?.url) params.set("url", paper.url);
  if (!params.toString()) return { found: false };

  const auth = await getAuth();
  return apiFetch(`/api/integrations/papers/lookup?${params.toString()}`, {}, !!auth?.access_token);
};

const getQueue = async () => {
  const stored = await storageGet({ [STORAGE_KEYS.offlineQueue]: [] });
  return Array.isArray(stored[STORAGE_KEYS.offlineQueue]) ? stored[STORAGE_KEYS.offlineQueue] : [];
};

const setQueue = (queue) => storageSet({ [STORAGE_KEYS.offlineQueue]: queue });

const enqueueImport = async (payload, reason) => {
  const queue = await getQueue();
  const idempotencyKey = payload.idempotency_key || crypto.randomUUID();
  const queued = {
    id: idempotencyKey,
    payload: {
      ...payload,
      idempotency_key: idempotencyKey
    },
    reason: reason || "offline",
    created_at: Date.now(),
    attempts: 0
  };
  await setQueue([...queue, queued]);
  return queued;
};

// Errors that will never succeed on a later attempt, so retrying is pointless.
// 409 is included because the server returns it when the paper exists but is not available to
// this user, or when the supplied identifiers refer to different papers. Neither resolves by
// waiting, so queueing them would retry forever and never surface to the user.
const TERMINAL_IMPORT_STATUSES = [400, 401, 403, 404, 409];

const isTerminalImportError = (error) =>
  Boolean(error?.authRequired) || TERMINAL_IMPORT_STATUSES.includes(error?.status);

const importPaper = async (payload) => {
  try {
    const result = await apiFetch("/api/integrations/papers/import", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    return { result, queued: false };
  } catch (error) {
    if (isTerminalImportError(error)) {
      throw error;
    }
    const queued = await enqueueImport(payload, error.message);
    return { result: queued, queued: true };
  }
};

async function retryQueue() {
  const auth = await getAuth();
  if (!auth?.access_token) return { retried: 0, remaining: (await getQueue()).length };

  const queue = await getQueue();
  const remaining = [];
  const dropped = [];
  let retried = 0;

  for (const item of queue) {
    try {
      await apiFetch("/api/integrations/papers/import", {
        method: "POST",
        body: JSON.stringify(item.payload)
      });
      retried += 1;
    } catch (error) {
      if (isTerminalImportError(error)) {
        // Drop it: re-queueing a terminal failure kept it in the queue indefinitely.
        dropped.push({ ...item, reason: error.message });
        continue;
      }
      remaining.push({
        ...item,
        attempts: (item.attempts || 0) + 1,
        reason: error.message,
        last_attempt_at: Date.now()
      });
    }
  }

  await setQueue(remaining);
  return { retried, remaining: remaining.length, dropped: dropped.length };
}

const getAuthStatus = async () => {
  const auth = await getAuth();
  const queue = await getQueue();
  const config = await getConfig();
  return {
    connected: !!auth?.access_token,
    user: auth?.user || null,
    environmentKey: config.environmentKey,
    environments: SCICOMMONS_ENVIRONMENTS,
    queueLength: queue.length
  };
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 5 });
});

chrome.runtime.onStartup.addListener(() => {
  retryQueue();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) retryQueue();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_AUTH_STATUS":
        return { ok: true, data: await getAuthStatus() };
      case "LOGIN":
        return { ok: true, data: await login() };
      case "LOGOUT":
        await storageRemove(STORAGE_KEYS.auth);
        return { ok: true, data: await getAuthStatus() };
      case "SET_ENVIRONMENT":
        if (!SCICOMMONS_ENVIRONMENTS[message.environmentKey]) {
          throw new Error("Unknown SciCommons environment.");
        }
        await storageSet({ [STORAGE_KEYS.environment]: message.environmentKey });
        await storageRemove(STORAGE_KEYS.auth);
        return { ok: true, data: await getAuthStatus() };
      case "LOOKUP_PAPER":
        return { ok: true, data: await lookupPaper(message.paper) };
      case "FETCH_CROSSREF_METADATA":
        return { ok: true, data: await fetchCrossrefMetadata(message.doi) };
      case "IMPORT_PAPER":
        return { ok: true, data: await importPaper(message.payload) };
      case "RETRY_QUEUE":
        return { ok: true, data: await retryQueue() };
      default:
        throw new Error("Unknown SciCommons extension command.");
    }
  })()
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error.message,
        status: error.status || null,
        authRequired: !!error.authRequired
      });
    });

  return true;
});

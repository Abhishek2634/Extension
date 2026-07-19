(() => {
  if (globalThis.__SCICOMMONS_CONTENT_SCRIPT_LOADED__) return;
  globalThis.__SCICOMMONS_CONTENT_SCRIPT_LOADED__ = true;

  const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;

  const cleanText = (value) =>
    String(value || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const cleanTitle = (value) =>
    cleanText(value)
      .replace(/^title:\s*/i, "")
      .replace(/\s+-\s+arxiv(?::.*)?$/i, "")
      .trim();

  const unique = (values) => {
    const seen = new Set();
    return values.filter((value) => {
      const key = cleanText(value).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const safeDecode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  const textFromMeta = (selectors) => {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const value = node?.getAttribute("content")?.trim();
      if (value) return value;
    }
    return "";
  };

  const allMeta = (selectors) => {
    const values = [];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => {
        const value = node.getAttribute("content")?.trim();
        if (value) values.push(value);
      });
    }
    return unique(values.map(cleanText));
  };

  const readJsonLd = () => {
    const entries = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        const parsed = JSON.parse(script.textContent || "");
        const queue = Array.isArray(parsed) ? [...parsed] : [parsed];

        while (queue.length) {
          const item = queue.shift();
          if (!item || typeof item !== "object") continue;
          entries.push(item);
          if (Array.isArray(item["@graph"])) queue.push(...item["@graph"]);
          if (Array.isArray(item.hasPart)) queue.push(...item.hasPart);
          if (Array.isArray(item.mainEntity)) queue.push(...item.mainEntity);
        }
      } catch {
        // Ignore malformed publisher JSON-LD.
      }
    });
    return entries;
  };

  const jsonLdEntries = readJsonLd();

  const typeMatches = (entry, acceptedTypes) => {
    const rawType = entry?.["@type"];
    const types = Array.isArray(rawType) ? rawType : [rawType];
    return types
      .filter(Boolean)
      .some((type) => acceptedTypes.includes(String(type).toLowerCase()));
  };

  const scholarlyJsonLd = jsonLdEntries.find((entry) =>
    typeMatches(entry, ["scholarlyarticle", "article", "techarticle", "report"])
  );

  const valueToText = (value) => {
    if (!value) return "";
    if (typeof value === "string" || typeof value === "number") return cleanText(value);
    if (Array.isArray(value)) return value.map(valueToText).filter(Boolean).join(", ");
    if (typeof value === "object") {
      return cleanText(value.name || value.headline || value.value || value["@id"] || "");
    }
    return "";
  };

  const jsonLdField = (keys) => {
    if (!scholarlyJsonLd) return "";
    for (const key of keys) {
      const value = valueToText(scholarlyJsonLd[key]);
      if (value) return value;
    }
    return "";
  };

  const jsonLdAuthors = () => {
    const authors = scholarlyJsonLd?.author || scholarlyJsonLd?.creator;
    if (!authors) return [];
    const list = Array.isArray(authors) ? authors : [authors];
    return unique(list.map(valueToText).filter(Boolean));
  };

  const jsonLdIdentifiers = () => {
    const identifiers = [];
    const candidates = [
      scholarlyJsonLd?.identifier,
      scholarlyJsonLd?.sameAs,
      scholarlyJsonLd?.url,
      scholarlyJsonLd?.mainEntityOfPage
    ];

    candidates.flat().forEach((candidate) => {
      if (!candidate) return;
      if (typeof candidate === "object") {
        identifiers.push(candidate.value, candidate.name, candidate["@id"], candidate.url);
      } else {
        identifiers.push(candidate);
      }
    });

    return identifiers.map(valueToText).filter(Boolean);
  };

  const canonicalUrl = () => {
    const href = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    if (!href) return location.href;
    try {
      return new URL(href, location.href).toString();
    } catch {
      return location.href;
    }
  };

  const normalizeDoi = (value) => {
    const decoded = safeDecode(cleanText(value));
    const match = decoded.match(DOI_PATTERN);
    const doi = match?.[0] || decoded.replace(/^doi:\s*/i, "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return doi.replace(/[.,;)\]]+$/, "").trim();
  };

  const detectDoi = () => {
    const metaDoi = textFromMeta([
      'meta[name="citation_doi"]',
      'meta[property="citation_doi"]',
      'meta[name="dc.identifier"]',
      'meta[name="DC.Identifier"]',
      'meta[name="doi"]',
      'meta[name="prism.doi"]',
      'meta[property="og:doi"]'
    ]);
    if (metaDoi) return normalizeDoi(metaDoi);

    for (const identifier of jsonLdIdentifiers()) {
      const normalized = normalizeDoi(identifier);
      if (DOI_PATTERN.test(normalized)) return normalized;
    }

    const candidates = [
      ...Array.from(document.querySelectorAll("a[href*='doi.org']")).map((a) => a.href),
      document.body?.innerText || ""
    ];
    for (const candidate of candidates) {
      const match = candidate.match(DOI_PATTERN)?.[0];
      if (match) return normalizeDoi(match);
    }
    return "";
  };

  const detectPmid = () => {
    const metaPmid = textFromMeta([
      'meta[name="citation_pmid"]',
      'meta[name="ncbi_uid"]',
      'meta[name="ncbi_uidbase"]',
      'meta[name="pmid"]'
    ]);
    if (metaPmid) return metaPmid.replace(/\D/g, "");

    for (const identifier of jsonLdIdentifiers()) {
      const match = identifier.match(/\b(?:pmid|pubmed)[:\s/]*(\d{4,})\b/i);
      if (match?.[1]) return match[1];
    }

    const match = location.href.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i);
    return match?.[1] || "";
  };

  const normalizeArxivId = (value) => {
    const normalized = cleanText(value)
      .replace(/^arxiv:\s*/i, "")
      .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
      .replace(/\.pdf$/i, "")
      .split(/[?#]/)[0]
      .trim();
    return normalized;
  };

  const detectArxivId = () => {
    const metaArxiv = textFromMeta([
      'meta[name="citation_arxiv_id"]',
      'meta[name="arxiv_id"]',
      'meta[name="eprints.id"]'
    ]);
    if (metaArxiv) return normalizeArxivId(metaArxiv);

    for (const identifier of jsonLdIdentifiers()) {
      const match = identifier.match(/(?:arxiv:|arxiv\.org\/(?:abs|pdf)\/)([^?#\s]+)/i);
      if (match?.[1]) return normalizeArxivId(match[1]);
    }

    const match = location.href.match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+)/i);
    return match?.[1] ? normalizeArxivId(match[1]) : "";
  };

  const detectTitle = () =>
    cleanTitle(
      textFromMeta([
        'meta[name="citation_title"]',
        'meta[property="og:title"]',
        'meta[name="dc.title"]',
        'meta[name="DC.Title"]',
        'meta[name="twitter:title"]'
      ]) ||
        jsonLdField(["headline", "name"]) ||
        document.querySelector("h1")?.textContent ||
        document.title
    );

  const detectAbstract = () =>
    cleanText(
      textFromMeta([
        'meta[name="citation_abstract"]',
        'meta[name="description"]',
        'meta[property="og:description"]',
        'meta[name="dc.description"]',
        'meta[name="DC.Description"]',
        'meta[name="twitter:description"]'
      ]) ||
        jsonLdField(["abstract", "description"]) ||
        document.querySelector("#abstract, .abstract, .article-abstract, [class*='abstract']")
          ?.textContent
    );

  const detectAuthors = () =>
    unique([
      ...allMeta([
        'meta[name="citation_author"]',
        'meta[name="dc.creator"]',
        'meta[name="DC.Creator"]',
        'meta[name="author"]'
      ]),
      ...jsonLdAuthors()
    ]);

  const detectPaper = () => ({
    doi: detectDoi(),
    pmid: detectPmid(),
    arxiv_id: detectArxivId(),
    title: detectTitle(),
    abstract: detectAbstract(),
    authors: detectAuthors(),
    url: canonicalUrl()
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SCICOMMONS_DETECT_PAPER") return false;
    sendResponse({ ok: true, paper: detectPaper() });
    return true;
  });
})();

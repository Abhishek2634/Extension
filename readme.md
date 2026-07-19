# SciCommons Extension.

A Chrome MV3 extension for detecting papers on publisher/preprint pages, checking whether they already exist on SciCommons, and saving them through the SciCommons integrations API.

The extension reads metadata from the current page first. When a DOI is found but important
metadata is missing, it falls back to CrossRef to fill title, abstract, and authors before saving.

## Environments

The extension supports two built-in environments:

- Local: `http://localhost:3000` frontend and `http://127.0.0.1:8000` backend
- Test: `https://test.scicommons.org` frontend auth and `https://backendtest.scicommons.org` API routing

Use the environment selector in the popup. Changing environments clears the stored extension token.

## Auth Flow

The extension no longer asks users to paste JWTs.

1. Popup sends the user to `/auth/extension` with a PKCE challenge.
2. The SciCommons web app uses the existing logged-in session or redirects to login.
3. The backend creates a short-lived one-time extension auth code.
4. The extension exchanges the code for API tokens.
5. Tokens are stored only in `chrome.storage.local` and are never sent to page JavaScript.

## Architecture

- `contentScript.js`: reads public page metadata only.
- `background.js`: owns authentication, API calls, and the offline retry queue.
- `popup.js`: renders user confirmation controls and sends commands to the background worker.
- `config.js`: local/test environment configuration.

## Development

1. Start the SciCommons backend on `http://127.0.0.1:8000`.
2. Start the SciCommons frontend on `http://localhost:3000`.
3. Open `chrome://extensions`.
4. Enable Developer mode.
5. Load this `extension/` folder as an unpacked extension.
6. Open a paper page and use the popup to connect and save.

For `test.scicommons.org`, select the Test environment in the popup and reconnect. Test auth opens
`https://test.scicommons.org`; paper lookup/import requests go to
`https://backendtest.scicommons.org`.

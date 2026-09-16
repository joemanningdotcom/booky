# Booky — auto-sort your Chrome bookmarks

Save every bookmark into one **Inbox** folder. Booky files it into the right folder for you — using the folders you already have, or creating a sensible new one when nothing fits. Rename, merge, or nest folders whenever you like; Booky reads the current names every time it sorts, so it just follows along.

Bring your own AI: Claude, OpenAI, Gemini, Groq, OpenRouter, a free local model via Ollama, or any OpenAI-compatible server. No account with Booky, no server in the middle — your browser talks to the provider you chose, and to nothing else.

## Install (unpacked)

Booky isn't on the Chrome Web Store (yet). Loading it yourself takes a minute:

1. Download this repo (**Code → Download ZIP** and unzip it, or `git clone`).
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. **Load unpacked** → pick the folder.
4. Booky creates an **Inbox** folder on your Bookmarks Bar if you don't already have a folder called `Inbox`. (Change the name or pick a different folder in Settings.)
5. Save a bookmark into Inbox once. Chrome's bookmark bubble remembers the last folder you used, so from then on the star button defaults to Inbox.

Works in any Chromium browser that supports Manifest V3 extensions (Chrome, Edge, Brave, Arc, …).

## Recommended: connect an AI provider

Right-click the Booky icon → **Options** → pick a provider → paste a key → **Test** → **Save**.

With a model connected, Booky shows it each bookmark's title and URL next to your folder names (plus a few example bookmarks from each folder) and files it the way you would. Without one, Booky falls back to local keyword/site matching, which is fine for folders that already have examples but weaker for new categories. If the API call fails for any reason, Booky uses the local matcher for that batch rather than leaving things unsorted, and tells you why in the popup.

| Provider | Notes | Get a key |
|---|---|---|
| **Anthropic (Claude)** | Default. `claude-opus-5` is preset; `claude-haiku-4-5` is the cheapest option. | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **OpenAI** | `gpt-5-mini` / `gpt-5-nano` are cheap and plenty for this. | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Google Gemini** | `gemini-2.5-flash` / `flash-lite`; a generous free tier at the time of writing. | [aistudio.google.com](https://aistudio.google.com/apikey) |
| **Groq** | Very fast open-weight models. | [console.groq.com](https://console.groq.com/keys) |
| **OpenRouter** | One key, hundreds of models from every vendor. | [openrouter.ai](https://openrouter.ai/keys) |
| **Ollama** | Free and fully local. Install Ollama, `ollama pull llama3.2`, pick Ollama in Settings. No key needed. | [ollama.com](https://ollama.com/download) |
| **Custom** | Any OpenAI-compatible `/v1` endpoint: LM Studio, vLLM, llama.cpp, LiteLLM, a company proxy, … | — |

The model field is free text with suggestions, so a model that came out after this README still works — just type its id.

**Cost.** A sort is one request per batch (up to 40 bookmarks), with your folder names and a handful of example titles as context. On the small/fast tiers of any provider it's a fraction of a cent per batch; you can lower "example bookmarks per folder" in Settings to shave it further.

**Privacy.** Keys are stored in `chrome.storage.local` for this browser profile only (never synced) and are only ever sent to the endpoint of the provider you chose. Booky asks for permission to reach that host when you save Settings; it has no other network access. What gets sent per sort: the titles and URLs of the bookmarks in your Inbox, your folder names, a few example bookmark titles/hostnames per folder, and any corrections you've made.

**Ollama tip.** If Test says it can't reach Ollama, make sure the Ollama app is running. Ollama allows Chrome extensions by default; if you've customised `OLLAMA_ORIGINS`, add `chrome-extension://*` to it.

## How it behaves

- **Trigger:** a bookmark created in (or moved into) Inbox starts a short countdown (default 4 s, so you can finish editing the title). Editing the title restarts it. A background sweep also runs every 15 minutes and on browser start, so nothing gets stuck.
- **No wasted requests:** the model is only called when there's a bookmark it hasn't looked at yet (new, retitled, undone, or dragged back in). A bookmark the model left in Inbox stays there quietly until you click **Sort now**, which asks about everything again. An empty Inbox never triggers a request.
- **Candidates:** every folder under the "categories" root (default: the same parent as Inbox, e.g. the Bookmarks Bar), including nested ones. Inbox itself is excluded.
- **New folders:** created next to your existing ones only when nothing fits. Turn this off in Settings to force everything into existing folders.
- **Learning:** if you move a bookmark out of the folder Booky picked, that's recorded as a correction and shown to the classifier next time. Undoing from the popup counts too.
- **Undo:** the popup lists recent moves with an Undo button. Undo means "not that folder": the bookmark goes back to Inbox, that folder is excluded for it, and it's re-sorted immediately. Dragging a bookmark back into Inbox yourself does the same thing.
- **Renaming:** folders are tracked by id, not name. Rename freely.

## Files

No build step — it's plain ES modules that Chrome loads directly.

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker: bookmark events, debounce, sweep alarm, applying moves, undo, corrections |
| `classifier.js` | LLM backend (Anthropic Messages API + OpenAI-compatible chat completions, structured JSON output) and the local heuristic backend |
| `providers.js` | Provider presets: endpoints, suggested models, which wire format to use |
| `bookmarks.js` | Helpers over `chrome.bookmarks` (resolve inbox/root, collect folders, ensure folder) |
| `settings.js` | Storage: settings (sync), API keys / log / corrections (local) |
| `popup.*` | Toolbar popup: inbox count, Sort now, recent activity with Undo |
| `options.*` | Settings page |

## Contributing

Issues and pull requests are welcome. Adding a provider is usually a one-entry change in `providers.js` if it speaks the OpenAI chat-completions format. To hack on it: edit the files, then hit the reload icon on `chrome://extensions` and reopen the popup.

## License

[MIT](LICENSE)

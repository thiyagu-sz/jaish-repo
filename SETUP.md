# Setup Guide

A step-by-step guide for running ResearchAI, written for someone who has not used
Node.js before. You can complete steps 1–7 in about ten minutes.

**Good news:** the app runs without any API keys. Steps 5 and 6 are optional.

---

## 1. Install Node.js

ResearchAI needs **Node.js version 18 or newer**.

1. Go to <https://nodejs.org>
2. Download the **LTS** version for your operating system.
3. Run the installer and accept the defaults.
4. Open a new terminal and check it worked:

```bash
node -v
npm -v
```

You should see a version number such as `v22.18.0`. If you see "command not found",
close the terminal, open a new one, and try again.

---

## 2. Get the project

If the project is on GitHub:

```bash
git clone <repository-url>
cd research-ai
```

If you already have the folder on your computer, just open a terminal inside it.

---

## 3. Open the folder in VS Code

1. Open VS Code.
2. **File → Open Folder...**
3. Select the project folder.
4. Open the built-in terminal with **Ctrl + `** (backtick), or **Terminal → New Terminal**.

Make sure the terminal is inside the project folder — you should see `package.json`
when you run `dir` (Windows) or `ls` (macOS/Linux).

---

## 4. Install dependencies

```bash
npm install
```

This creates a `node_modules` folder. It only installs two packages, so it should
finish quickly. You only need to do this once.

---

## 5. Create your `.env` file (optional)

The `.env` file holds your secret keys. It is never committed to Git.

**Windows (Command Prompt / PowerShell):**

```bash
copy .env.example .env
```

**macOS / Linux:**

```bash
cp .env.example .env
```

You now have a `.env` file with empty values. **You can leave it empty** — the app will
run in Demo Mode. Continue to step 7 if you just want to see it working.

---

## 6. Add API keys (optional)

Open `.env` in VS Code and paste your keys after the `=` signs. No quotes, no spaces.

```
OPENAI_API_KEY=paste-your-key-here
```

### Where to get the keys

| Key | Needed for | Where to get it |
| --- | --- | --- |
| `OPENAI_API_KEY` | Real AI summaries, gaps and ideas | <https://platform.openai.com/api-keys> — see the [OpenAI quickstart](https://platform.openai.com/docs/quickstart) |
| `SEMANTIC_SCHOLAR_API_KEY` | Higher Semantic Scholar rate limits | Request one at <https://www.semanticscholar.org/product/api#api-key-form> — see the [API docs](https://api.semanticscholar.org/api-docs/) |

**You do not need a key for paper search.** The primary source, [OpenAlex](https://docs.openalex.org/),
is free and requires no key. Adding your email as `CONTACT_EMAIL` in `.env` puts you in
their faster "polite pool", which they appreciate but do not require.

> **Note on billing:** an OpenAI API key is a paid product, separate from a ChatGPT
> subscription. You need credit on the account for AI responses to work. If the key is
> missing, invalid, or out of credit, the app falls back to Demo Mode instead of crashing.

### Keeping keys safe

- Never paste a key into `index.html`, any file in `public/js/`, the README, or a chat message.
- Never commit `.env`. It is already listed in `.gitignore`.
- If you accidentally expose a key, revoke it immediately in the provider's dashboard
  and generate a new one.

---

## 7. Start the application

```bash
npm start
```

You should see:

```
ResearchAI running at http://localhost:3000
```

If no key is configured you will also see a reminder that AI insights will use Demo Mode.

---

## 8. Open it in your browser

Go to **<http://localhost:3000>**

Try it out:

1. Type a topic such as `knowledge graphs for research` and press **Enter**.
2. Click a paper title to open the detail panel.
3. Click **Summarize Paper**, **Find Research Gaps** or **Generate Research Ideas**.

To stop the server, press **Ctrl + C** in the terminal.

---

## 9. Demo mode: how to turn it on and off

Demo Mode is automatic. There is no switch to flip.

| Situation | What happens |
| --- | --- |
| No `OPENAI_API_KEY` | AI responses use sample text, badged **Demo Mode** |
| Invalid key or no credit | Same — falls back to sample text, no crash |
| Valid `OPENAI_API_KEY` | Real AI responses, no badge |
| All paper sources fail | Six sample papers, with a banner explaining why |
| Any source responds | Real search results |

**To turn demo mode off:** add a working `OPENAI_API_KEY` to `.env` and restart the
server (Ctrl + C, then `npm start`).

**To force demo mode on** (useful for a presentation with no internet): remove or
comment out `OPENAI_API_KEY` in `.env` and restart.

> The server reads `.env` only at startup. **Always restart after editing it.**

---

## 10. Push your changes to GitHub

First, check what will be committed:

```bash
git status
```

**Confirm that `.env` is NOT in the list.** If it appears, stop and check that
`.gitignore` contains a line reading `.env`.

Then:

```bash
git add .
git commit -m "Describe what you changed"
git push
```

If this is a brand-new repository:

```bash
git init
git add .
git commit -m "Initial commit: ResearchAI MVP"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `'node' is not recognized` | Node.js is not installed or the terminal is stale. Reinstall, then open a **new** terminal. |
| `Cannot find module 'express'` | You skipped `npm install`. Run it in the project folder. |
| `EADDRINUSE: address already in use :::3000` | Another program is on port 3000. Either stop it, or set `PORT=3001` in `.env` and restart. |
| Page loads but search does nothing | The server is not running. Check the terminal for `ResearchAI running at...`. |
| Everything says "Demo Mode" | Expected without an `OPENAI_API_KEY`. Add one and restart. |
| Search always shows demo papers | Your network may be blocking the scholarly APIs, or you are rate-limited. Wait a minute and retry. |
| Semantic Scholar returns nothing | Without a key it is often rate-limited (HTTP 429). Use the **All** or **OpenAlex** source filter. |
| Edited `.env` but nothing changed | Restart the server. `.env` is read only at startup. |

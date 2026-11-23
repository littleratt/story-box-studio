# Story Box Studio — setup

The Studio has two parts:

| Part | Where it lives | What it does |
|---|---|---|
| Back end (`apps-script/`) | Your Google account (Apps Script + a "Story Box" Drive folder) | Stores stories and figures, and lets the box download them |
| Studio page (`docs/index.html`) | Any free https web host (GitHub Pages) | Records chapters, makes MP3s and covers, and scans figures on Android |

## Part 1: back end (about 10 minutes)

1. Go to <https://script.google.com> and click **New project**. Name it **Story Box**.
2. Click **Project Settings** (the gear icon) and tick **Show "appsscript.json" manifest file in editor**.
3. Back in the **Editor**, open `appsscript.json` and replace everything in it with this folder's `apps-script/appsscript.json`.
4. Open `Code.gs` and replace everything with this folder's `apps-script/Code.gs`. Click **Save**.
5. In the function menu at the top, choose **setup** and click **Run**. Google asks for permission:
   choose your account, then **Advanced → Go to Story Box (unsafe)** → **Allow**.
   ("Unsafe" only means Google hasn't reviewed a script you wrote yourself.)
6. The **Execution log** shows three lines: the Drive folder address, **STUDIO_KEY** and **BOX_KEY**. Keep this tab open.
7. Click **Deploy → New deployment**. Under "Select type" (the gear icon) choose **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

Why "Anyone": the box can't sign in to Google. Every request still needs one of the two secret keys,
and the box's key can only *download* story files.

**Later code changes:** use **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**,
so the web app URL stays the same.

## Part 2: Studio page

The page is published by GitHub Pages from the `docs/` folder at https://littleratt.github.io/story-box-studio/
Then make your **setup link** by joining the page address with the URL and key:

```
https://littleratt.github.io/story-box-studio/#api=<Web app URL>&key=<STUDIO_KEY>
```

Open the setup link once on each phone or computer you use. It remembers the connection after that.
Keep the link private: anyone who has it can change your stories.

## Keys

- **STUDIO_KEY**: for the Studio page. Lets someone change stories.
- **BOX_KEY**: goes on the box's SD card (next firmware update). Only lets someone download story files.
- If a key leaks: in Apps Script, open **Project Settings → Script properties**, delete it, and run `setup` again.
  That creates a new one. Then update the setup link (or the SD card).

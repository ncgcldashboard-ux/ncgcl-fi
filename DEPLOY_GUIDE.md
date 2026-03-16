# NCGCL FI System — Windows Deploy Guide
## From zero to live in under 3 hours

---

## What you'll end up with

```
Your browser (anywhere in the world)
        │
        ▼
GitHub Pages — dashboard (free, permanent, no server needed)
        │
        ▼  API calls
Railway — backend API (free, runs 24/7 in the cloud)
        │
        ▼  database
Railway PostgreSQL — your data (persists forever)
```

Your Windows PC is only needed for the initial setup.
After that, everything runs in the cloud. You can turn your laptop off.

---

## FILES IN THIS PACKAGE

```
ncgcl-fi/
├── SETUP_WINDOWS.bat        ← run this first
├── DEPLOY_GUIDE.md          ← this file
├── frontend/
│   └── index.html           ← the dashboard (goes to GitHub Pages)
└── backend/
    ├── server.js            ← the API
    ├── package.json         ← Node.js dependencies
    └── railway.toml         ← Railway deployment config
```

---

## STEP 1 — Install Node.js (5 minutes)

Node.js is needed to install the backend's dependencies before uploading.

1. Open your browser
2. Go to **nodejs.org**
3. Click the green **"LTS"** button — this downloads the installer
4. Open the downloaded `.msi` file
5. Click **Next** through every screen — accept all defaults
6. Click **Finish**

**Verify it worked:**
Press `Win + R` → type `cmd` → press Enter
Type this and press Enter:
```
node --version
```
You should see something like `v20.11.0`. If you do, Node.js is installed.

---

## STEP 2 — Run the setup script (2 minutes)

1. Find `SETUP_WINDOWS.bat` in this package
2. **Double-click** it
3. A black window opens and runs automatically
4. When it says "Setup complete!" — press any key to close

This creates your project folder at:
```
C:\Users\YourName\Desktop\ncgcl-fi\
```
And installs all backend dependencies into it.

---

## STEP 3 — Set up GitHub (10 minutes)

### 3.1 Create a GitHub account (if you don't have one)
Go to **github.com** → click **Sign up** → follow the steps.

### 3.2 Install GitHub Desktop
1. Go to **desktop.github.com**
2. Click **Download for Windows**
3. Run the installer
4. Sign in with your GitHub account

### 3.3 Create the repository
1. Open GitHub Desktop
2. Click **File → New Repository**
3. Fill in:
   - **Name:** `ncgcl-fi`
   - **Local path:** `C:\Users\YourName\Desktop` (your Desktop)
   - Leave everything else as default
4. Click **Create Repository**

### 3.4 Copy your files into the repo

Open **File Explorer** and navigate to:
`C:\Users\YourName\Desktop\ncgcl-fi\`

This folder was just created by GitHub Desktop. Now copy files into it:

| Copy this file | Into this folder |
|----------------|-----------------|
| `frontend\index.html` | `ncgcl-fi\frontend\` |
| `backend\server.js` | `ncgcl-fi\backend\` |
| `backend\package.json` | `ncgcl-fi\backend\` |
| `backend\railway.toml` | `ncgcl-fi\backend\` |
| `backend\node_modules\` | `ncgcl-fi\backend\` |

Create a `.github\workflows\` folder inside `ncgcl-fi` and add this file:

**File: `.github\workflows\deploy.yml`**
Create a new text file, rename it `deploy.yml`, and paste this content:
```yaml
name: Deploy frontend to GitHub Pages

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - name: Deploy frontend
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./frontend
```

### 3.5 Push to GitHub

1. Go back to **GitHub Desktop**
2. You'll see all your files listed on the left
3. In the **Summary** box at the bottom left, type: `Initial deployment`
4. Click **Commit to main**
5. Click **Publish repository** (top right)
   - Make sure **Keep this code private** is **unchecked**
   - Click **Publish Repository**

### 3.6 Enable GitHub Pages

1. Go to **github.com** in your browser
2. Click on your `ncgcl-fi` repository
3. Click **Settings** (top menu bar)
4. Click **Pages** (left sidebar)
5. Under **Source**, select:
   - Branch: `gh-pages`
   - Folder: `/ (root)`
6. Click **Save**

⚠️ The `gh-pages` branch appears automatically after the first GitHub Action runs.
If you don't see it yet, wait 3 minutes and refresh.

Your dashboard URL will be:
**`https://YOURUSERNAME.github.io/ncgcl-fi/`**

---

## STEP 4 — Deploy the backend on Railway (15 minutes)

### 4.1 Create a Railway account
1. Go to **railway.app**
2. Click **Login**
3. Select **Login with GitHub**
4. Authorize Railway

### 4.2 Create a new project
1. Click **New Project**
2. Select **Deploy from GitHub repo**
3. You'll see your repos — click **ncgcl-fi**
4. Railway asks for a root directory → type `backend`
5. Click **Deploy Now**

Watch the **Build Logs** panel on the right.
You'll see it run `npm install` and then `node server.js`.
When it says `NCGCL FI API running on port...` — it's live.

### 4.3 Add a PostgreSQL database
1. In your Railway project dashboard, click **+ New**
2. Select **Database**
3. Select **Add PostgreSQL**
4. Railway creates the database and automatically connects it

Railway automatically adds a `DATABASE_URL` environment variable to your backend.
Your server reads this and connects to the database on startup.

### 4.4 Get your backend URL
1. Click on your backend service (not the database)
2. Click the **Settings** tab
3. Scroll to **Networking** → **Public Networking**
4. Click **Generate Domain**
5. Copy the URL — it looks like:
   `https://ncgcl-fi-production-xxxx.up.railway.app`

**Save this URL — you need it in the next step.**

---

## STEP 5 — Connect the dashboard to Railway (5 minutes)

### 5.1 Edit index.html

1. Open File Explorer → go to `C:\Users\YourName\Desktop\ncgcl-fi\frontend\`
2. Right-click `index.html` → **Open with** → **Notepad**
3. Press **Ctrl+F** to open Find
4. Search for: `window.NCGCL_API_URL`
5. You'll find this line:
   ```javascript
   const API_URL = (window.NCGCL_API_URL || "").replace(/\/$/, "");
   ```
6. Replace it with your Railway URL:
   ```javascript
   const API_URL = "https://ncgcl-fi-production-xxxx.up.railway.app";
   ```
7. Press **Ctrl+S** to save

### 5.2 Push the change

1. Open **GitHub Desktop**
2. You'll see `index.html` listed as a changed file
3. Summary: `Connect frontend to Railway API`
4. Click **Commit to main**
5. Click **Push origin**

GitHub Actions rebuilds the site automatically. Wait 2 minutes.

---

## STEP 6 — Verify everything works (5 minutes)

### Check 1 — Backend health
Open your browser and go to:
```
https://YOUR-RAILWAY-URL.up.railway.app/health
```
You should see: `{"status":"ok","ts":"..."}`

### Check 2 — Holdings loaded
```
https://YOUR-RAILWAY-URL.up.railway.app/api/holdings
```
You should see a JSON response with 7 sample holdings.

### Check 3 — Dashboard
Go to: `https://YOURUSERNAME.github.io/ncgcl-fi/`

Look for the **● Live** green indicator in the top-left header.
If it says **● Demo**, the API URL is not connected yet — recheck Step 5.

---

## STEP 7 — Enter your real holdings

### Option A — Through the dashboard UI
Click **+ Add** in the top right.
Fill in each holding. Click **Add to Portfolio**.
Data saves to Railway PostgreSQL immediately.

### Option B — Edit data visually (recommended for bulk changes)

Railway includes a built-in database viewer:

1. Go to **railway.app** → your project
2. Click the **PostgreSQL** service
3. Click the **Data** tab
4. You'll see all your tables in a spreadsheet view
5. Click any row to edit it directly
6. Click any **+** button to add a new row

This is the easiest way to enter or bulk-edit your real portfolio data.

---

## HOW TO UPDATE PRICES DAILY

1. Open the dashboard: `https://YOURUSERNAME.github.io/ncgcl-fi/`
2. Go to **Holdings** tab
3. Click any price field → type the new price → press **Enter**
4. Click **↻ Revalue** in the top nav to snapshot the portfolio

---

## HOW TO PUSH FUTURE CHANGES

Whenever you change any file:

1. Make your edit (e.g. change something in `index.html`)
2. Open **GitHub Desktop**
3. You'll see changed files listed automatically
4. Write a summary → **Commit to main** → **Push origin**

- GitHub Pages updates the dashboard within 2 minutes
- Railway redeploys the backend within 3 minutes

---

## TROUBLESHOOTING

| Problem | Solution |
|---------|----------|
| Dashboard shows ● Demo | API URL wrong in index.html — recheck Step 5 |
| Railway build fails | Click **Build Logs** in Railway to see the error |
| `gh-pages` branch missing | Wait 3 min, check **Actions** tab in GitHub for errors |
| Can't find `.github` folder | Windows hides folders starting with `.` — see note below |
| Database tables missing | Server creates them automatically on first start |
| CORS error in browser console | Make sure API_URL has no trailing slash |

**Note on hidden folders on Windows:**
To see the `.github` folder in File Explorer:
1. Open File Explorer
2. Click **View** in the top menu
3. Check **Hidden items**

---

## YOUR PERMANENT URLS

Write these down:

| Service | URL |
|---------|-----|
| Dashboard | `https://YOURUSERNAME.github.io/ncgcl-fi/` |
| API | `https://YOUR-RAILWAY-URL.up.railway.app` |
| Railway dashboard | `https://railway.app` |
| GitHub repo | `https://github.com/YOURUSERNAME/ncgcl-fi` |

---

## COSTS

| Service | Cost |
|---------|------|
| GitHub Pages | Free |
| Railway backend | Free (500 hours/month) |
| Railway PostgreSQL | Free (1GB storage) |
| **Total** | **$0/month** |

Railway's free tier covers normal usage easily.
If you ever exceed the free tier, the paid plan is $5/month.

---

*NCGCL Fixed Income Portfolio System — Windows Deploy Guide*
*All cloud services run 24/7 independently of your PC*

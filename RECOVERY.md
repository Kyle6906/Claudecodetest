# AFL Sales Tracker — Recovery Instructions

If you need to restore this app on a new or repaired computer, follow these steps in order.

---

## Step 1 — Install Required Software

1. **Node.js** — download and install from [nodejs.org](https://nodejs.org) (choose the LTS version)
2. **Git** — download and install from [git-scm.com](https://git-scm.com)

Restart your computer after installing both.

---

## Step 2 — Get the App Code from GitHub

Open a command prompt (search "cmd" in the Start menu) and run:

```
git clone https://github.com/Kyle6906/Claudecodetest.git
cd Claudecodetest
```

This downloads the complete app code to a folder called `Claudecodetest` in whatever directory you ran the command from.

---

## Step 3 — Install Dependencies

Still in the command prompt, run:

```
npm install
```

This downloads the required packages (Electron, SheetJS, etc.) into a `node_modules` folder. It may take a minute.

---

## Step 4 — Launch the App

```
npm start
```

The AFL Sales Tracker window will open. At this point the app is running but has no data yet.

---

## Step 5 — Restore Your Data from OneDrive

Your customer data (contacts, quotes, sales, tasks, etc.) was backed up separately to OneDrive and is not stored in GitHub.

1. Open the app
2. Click the **backup status indicator** in the bottom-left corner of the app
3. Click the **Restore from Backup** tab
4. You will see a list of backup files from your OneDrive folder:
   `C:\Users\[your username]\OneDrive - Atlanta Fork Lifts Inc\AFL App Backups\`
5. Click **Restore** on the most recent backup file
6. Confirm the restore when prompted
7. The app will reload with all your data restored

---

## Backup Locations

| What | Where |
|------|-------|
| App code | GitHub: https://github.com/Kyle6906/Claudecodetest |
| Customer data & settings | OneDrive: `AFL App Backups\` folder |
| Uploaded documents | OneDrive: sync'd automatically |

---

## If OneDrive Isn't Signed In Yet

Sign into OneDrive on the new computer first so the `OneDrive - Atlanta Fork Lifts Inc` folder is available. The backup files will sync automatically once signed in.

---

## Contact

GitHub account: Kyle6906  
Email: kylewaiterealestate@gmail.com

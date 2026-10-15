# AFL Sales Tracker — Mobile PWA Setup

## Live URL

**https://afl-sales-tracker-52890.web.app**

---

## Deploy to Firebase Hosting

Run these commands once in the project root:

```bash
npm install -g firebase-tools
firebase login
firebase deploy
```

After deploy, the app is live at `https://afl-sales-tracker-52890.web.app`.  
Re-run `firebase deploy` any time you update files in the `mobile/` folder.

---

## Install on iPhone (Safari)

1. Open **Safari** and go to `https://afl-sales-tracker-52890.web.app`
2. Tap the **Share** button (box with arrow pointing up) at the bottom of Safari
3. Scroll down and tap **Add to Home Screen**
4. Tap **Add** in the top-right corner
5. The AFL Sales icon appears on your home screen — tap it to open the full-screen app

> Note: iOS requires Safari specifically. Chrome on iPhone will not show the Add to Home Screen option.

---

## Install on Android (Chrome)

1. Open **Chrome** and go to `https://afl-sales-tracker-52890.web.app`
2. When the install banner appears at the bottom, tap **Install**
   - If the banner doesn't appear, tap the **three dots** menu (⋮) in the top-right
   - Tap **Add to Home Screen** → **Install**
3. The AFL Sales icon appears on your home screen

---

## Features

| Tab | Description |
|-----|-------------|
| **Home** | Dashboard with open tasks, open quotes, contact count, recent activity |
| **Fleet** | Search territory equipment by zip code, age, and priority — sorted by oldest fleet |
| **Contacts** | Live search all contacts, tap to open full profile with satellite map |
| **Tasks** | View overdue/today/upcoming tasks, complete tasks, add new tasks |
| **Quote** | Create a new quote from the field — syncs to desktop app in real time |

---

## Offline Mode

- The app caches all data in the browser's localStorage on first load
- When offline, it shows the cached data with a warning banner
- Pull down on the main content area to refresh when back online
- Quotes and notes saved while offline will sync when connectivity returns

---

## Firebase Anonymous Auth

Both the desktop app and mobile PWA use anonymous Firebase authentication.  
This must be enabled once in the Firebase Console:

1. Go to https://console.firebase.google.com/project/afl-sales-tracker-52890/authentication/providers
2. Click **Anonymous**
3. Toggle **Enable** → click **Save**

---

## Project: `afl-sales-tracker-52890`

- Firebase Console: https://console.firebase.google.com/project/afl-sales-tracker-52890
- Firestore data: https://console.firebase.google.com/project/afl-sales-tracker-52890/firestore
- Hosting: https://console.firebase.google.com/project/afl-sales-tracker-52890/hosting

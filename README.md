# 🩸 BloodLink

Citizen-first mobile platform that connects blood donors, recipients, and hospital administrators with real-time matching, push notifications, and operational oversight.

---

## 📌 Why BloodLink?

- **Receivers** raise urgent requests with hospital, city, and blood-group context in less than a minute.
- **Donors** receive instant matches based on their profile, location, and blood group.
- **Admins** monitor the entire ecosystem, verify requests, manage users, and track fulfilment metrics.
- **Healthcare partners** benefit from automated notifications, built-in OTP verification, and multilingual support.

---

## 🗺️ Product Flow at a Glance

| Step | Actor                 | Action                                                         | Real-time Event                                                               |
| ---- | --------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1    | **Receiver**          | Submits a blood request                                        | `Bloodreceiver` document created with `status: "pending"`                     |
| 2    | **Donor listener**    | `onSnapshot` on city + blood group                             | Donor cards update instantly in Donor Notification screen                     |
| 3    | **Donor**             | Accepts / declines request                                     | `responses` array updated inside the specific `Bloodreceiver/{requestId}` doc |
| 4    | **Receiver listener** | `onSnapshot(doc(db,'Bloodreceiver', requestId))`               | Receiver sees donor response instantly, NEW badge removed once viewed         |
| 5    | **Backend**           | Sends push notification (FCM) & persists audit logs            | Delivery success/failure logged to console                                    |
| 6    | **Admin**             | Reviews dashboards (matched pairs, analytics, user management) | Changes propagated to Firestore in real time                                  |

> ✅ Both donor and receiver screens rely solely on Firestore listeners – no manual refresh required. Token refresh logic keeps FCM tokens current, so push notifications continue to deliver even after reinstall.

---

## 🧱 Core Architecture

```
┌────────────┐      ┌──────────────────┐      ┌────────────────────┐
│  Expo App  │──FCM─► Firebase Cloud   │──►   │ Donor / Receiver UI │
│ (React     │      │ Messaging        │      │ (real-time cards)   │
│  Native)   │      └──────────────────┘      └────────────────────┘
│            │
│  useFcm    │  REST ┌──────────────────┐    Firestore
│  TokenMgr  │◄──────┤ Node Backend     ├──────────────┐
│  onSnapshot│       │ (Express +       │               │
│            │       │ Firebase Admin)  │               ▼
│            │       └──────────────────┘      ┌────────────────┐
│            │                                 │ Collections    │
└────────────┘                                 │  users         │
                                               │  BloodDonors   │
                                               │  Bloodreceiver │
                                               └────────────────┘
```

- **Mobile client:** Expo (React Native) + React Navigation + AsyncStorage
- **Backend service (`backend/`):** Express server that sends OTP emails (Nodemailer) and FCM notifications (Firebase Admin SDK)
- **Realtime database:** Cloud Firestore with granular listeners (collection + per-document)
- **Authentication:** Firebase Auth (Email/password); OTP validation handled by backend
- **Push notifications:** Firebase Cloud Messaging; tokens stored per user with automatic refresh

---

## 🛠️ Tech Stack

| Layer         | Technology                                                                              |
| ------------- | --------------------------------------------------------------------------------------- |
| UI            | React Native (Expo) · React Native Paper · Lottie                                       |
| Navigation    | React Navigation (Stack, Drawer)                                                        |
| State         | React Context · Custom hooks (`useTranslation`, `useFirebaseOtp`, `useFcmTokenManager`) |
| Data          | Cloud Firestore (`users`, `BloodDonors`, `Bloodreceiver`)                               |
| Auth          | Firebase Authentication (email/password)                                                |
| Notifications | Firebase Cloud Messaging with token refresh + Express proxy                             |
| Backend       | Node.js · Express · Nodemailer · Firebase Admin SDK                                     |
| Tooling       | Expo Dev Client · EAS Build · ESLint                                                    |

---

## 🔄 Real-time Listener Strategy

### Donor notifications

```js
const donorQuery = query(
  collection(db, "Bloodreceiver"),
  where("bloodGroup", "==", matchingBloodGroup),
  where("city", "==", matchingCity),
  where("status", "==", "pending")
);

onSnapshot(donorQuery, (snapshot) => {
  // ...render donor notification cards
});
```

### Receiver notifications

- Subscribe to the receiver’s own `Bloodreceiver` documents.
- Attach a secondary listener per document so updates to `responses[]` or `status` propagate instantly.

```js
const receiverQuery = query(
  collection(db, "Bloodreceiver"),
  where("uid", "==", currentUid)
);

const unsubscribe = onSnapshot(receiverQuery, (snapshot) => {
  snapshot.docs.forEach((docSnap) => {
    const docRef = doc(db, "Bloodreceiver", docSnap.id);
    onSnapshot(docRef, (doc) => setReceiverDoc(doc.id, doc.data()));
  });
});
```

- `buildReceiverResponses` translates the `responses` array into UI cards, complete with NEW badges and highlight states.

### FCM token management

- `useFcmTokenManager` (hook in `src/hooks`) runs globally:
  - Requests notification permissions
  - Fetches/stores token in `users/{uid}` with `fcmUpdatedAt`
  - Subscribes to `messaging().onTokenRefresh` to update Firestore automatically
  - Called on app launch and after login/signup (`LoginScreen`, `OtpScreen`)

---

## 📣 Push Notification Process

1. **Token registration (mobile)**

- `useFcmTokenManager` requests notification permission as soon as the user signs in or relaunches the app.
- The hook obtains the device token (`messaging().getToken()`), caches it locally, and writes it into `users/{uid}` together with `fcmUpdatedAt`.
- `messaging().onTokenRefresh` keeps the Firestore record in sync whenever the OS rotates the token.

2. **Event triggers (Firestore)**

- When a receiver submits a request the document `Bloodreceiver/{requestId}` is created.
- Donors accept or decline from the Donor Notifications screen, which updates the `responses` array and status fields inside the same document via Firestore SDK calls.
- Those document changes are observed in real time by both donor and receiver screens (`onSnapshot`).

3. **Outbound notification (mobile → backend)**

- Inside `src/services/backendClient.js`, `sendPushNotification` posts to the Express backend (`/notify`) with the target user ID, notification title/body, and data payload.
- The client never sends the Firebase admin credentials; it only supplies the recipient’s UID so the server can resolve the token securely.

4. **Message dispatch (backend)**

- The Express server loads the recipient’s token from Firestore using the Firebase Admin SDK.
- It calls `admin.messaging().send({ token, notification, data })` and returns the FCM message ID to the caller.
- Successes and errors are logged with token suffixes so operators can diagnose delivery issues without exposing full tokens.

5. **User experience update (mobile)**

- The receiver device receives the push notification and displays it immediately.
- Simultaneously, the onSnapshot listener for `Bloodreceiver/{requestId}` reflects the new donor response, which removes the NEW badge once viewed.
- The Notifications screen provides a “Mark as Seen” action that updates Firestore so subsequent app sessions start in a clean state.

> 🔁 The push flow is resilient: even if the device misses the notification (offline), the Firestore listener ensures the UI state is accurate when connectivity returns.

---

## 🔐 Firestore Collections (Key Fields)

| Collection      | Purpose                     | Important Fields                                                                     |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| `users`         | Profile, role, device token | `name`, `city`, `bloodGroup`, `isAdmin`, `fcmToken`, `fcmUpdatedAt`                  |
| `BloodDonors`   | Donor registry              | `uid`, `city`, `bloodGroup`, `isActive`                                              |
| `Bloodreceiver` | Requests & responses        | `uid`, `bloodGroup`, `city`, `responses[]`, `status`, `seenBy[]`, `requiredDateTime` |

> Firestore security rules should enforce that donors only see anonymous request summaries and receivers can only read their own requests.

---

## 🧾 Setup Guide

### 1. Environment variables (Expo)

Copy `.env.example` → `.env` and provide values from Firebase project settings.

```
EXPO_PUBLIC_FIREBASE_API_KEY=
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=
EXPO_PUBLIC_FIREBASE_PROJECT_ID=
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
EXPO_PUBLIC_FIREBASE_APP_ID=
EXPO_PUBLIC_ADMIN_EMAIL=
EXPO_PUBLIC_ADMIN_PASSWORD=
EXPO_PUBLIC_API_BASE_URL=http://localhost:4000
```

> Prefixing with `EXPO_PUBLIC_` exposes them to the client (Expo requirement). Do **not** place secrets here unless intended for client use.

### 2. Firebase files

- `google-services.json` → project root (Android)
- (Optional) `GoogleService-Info.plist` → project root (iOS)

### 3. Backend service (`backend/`)

```
cd backend
cp .env.example .env
# populate EMAIL_USER + EMAIL_PASSWORD (app password recommended)

npm run dev
```

- `EMAIL_USER`/`EMAIL_PASSWORD` are Gmail credentials used by Nodemailer to deliver OTP codes.
- Server exposes `/auth/sendOtp`, `/auth/verifyOtp`, `/auth/resend`, `/notify`, and `/health`.

### 4. Run the mobile app

```
## 📄 License
npx expo start --dev-client
```

- Press `a` for Android emulator, `i` for iOS simulator, or scan the QR code with Expo Go.

---

## 📂 Folder Structure (Simplified)

```
MyNewApp/
├── App.js                      # Bootstraps providers, navigation, FCM token manager
├── assets/                     # Images, Lottie animations, README media
├── backend/                    # Express server for OTP + FCM proxy
├── src/
│   ├── components/             # Reusable UI components
│   ├── contexts/               # App-wide contexts (e.g., LanguageContext)
│   ├── hooks/                  # Custom hooks (firebase OTP, translation, FCM)
│   ├── navigation/             # Stack, drawer, and admin navigators
│   ├── screens/                # Donor, receiver, admin, onboarding screens
│   ├── services/               # Firebase auth, Firestore helpers, API client
│   ├── translations/           # Multilingual copy deck
│   └── utils/                  # Helpers (formatting, device utils, etc.)
├── google-services.json        # Android Firebase config (not committed)
├── .env.example                # Expo environment template
├── app.json                    # Expo project config
└── eas.json                    # EAS build profiles
```

---

## ⚙️ Development & QA Workflow

1. `npm run dev` inside `backend/` to keep OTP + notification server alive.
2. `npx expo start --dev-client` to launch the app with native modules enabled.
3. Use the in-app language toggle to test multi-language copy.
4. Create a receiver request → observe donor notification card appear.
5. Accept request as donor → verify receiver card updates instantly and push notification delivered (check backend logs).
6. Use `Refresh` gesture to confirm the UI state is consistent.

---

## 🚀 Build & Distribution

| Target                     | Command                                      |
| -------------------------- | -------------------------------------------- |
| Android (dev)              | `eas build -p android --profile development` |
| Android (store)            | `eas build -p android --profile production`  |
| iOS (testflight/app store) | `eas build -p ios --profile production`      |

Ensure credentials/keystores are managed via EAS secrets or your preferred secret manager. For push notifications in production, configure FCM/APNs keys under your Expo project dashboard.

---

## 🔒 Security Tips

- Rotate default admin credentials before going live.
- Lock down Firestore rules by role (`isAdmin`, `isDonor`, `uid == request.uid`).
- Never embed backend secrets in the Expo app; keep SMTP/FCM admin keys server-side.
- Enable App Check or device verification if exposing REST endpoints publicly.
- Consider rate limiting `/auth/sendOtp` and `/notify` endpoints beyond the built-in server controls.

---

## 🙌 Contributing

1. Fork the repo & create a branch: `git checkout -b feature/my-improvement`
2. Run backend + mobile app locally; verify flows end-to-end.
3. Submit a PR referencing screenshots or logs for complex flows.
4. Follow conventional commit style where possible (`feat:`, `fix:`, `chore:`).

---

## 📞 Support & Contact

- Maintainer: **HAARHISH**
- Repo: [github.com/HSBEAST23/MyNewApp](https://github.com/HSBEAST23/MyNewApp)
- Issues: Use GitHub Issues for bug reports or feature requests

> Built with ❤️ to make lifesaving connections faster, safer, and smarter.

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

---

## 📬 Contact

- **Project Maintainer:** HAARHISH
- **Repository:** [https://github.com/HSBEAST23/MyNewApp](https://github.com/HSBEAST23/MyNewApp)

<div align="center">
   <sub>Built with ❤️ to support lifesaving causes.</sub>
</div>

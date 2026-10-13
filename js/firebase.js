// Group study's connection to Firebase (SPEC 6.1): Realtime Database plus
// Auth. Students sign in anonymously and invisibly; the host signs in with
// email and password. Firebase's code is only downloaded when firebaseConfig
// in config.js is filled in, so the rest of the site works without it.
import { firebaseConfig } from './config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

export const groupStudyOn = () => !!firebaseConfig;

let starting = null;
let anonymousSignIn = null;

function start() {
  starting ??= (async () => {
    if (!firebaseConfig.databaseURL) {
      throw Object.assign(new Error('firebaseConfig in js/config.js has no databaseURL.'), { code: 'config/no-database-url' });
    }
    let appSdk, authSdk, dbSdk;
    try {
      [appSdk, authSdk, dbSdk] = await Promise.all([
        import(`${SDK}/firebase-app.js`),
        import(`${SDK}/firebase-auth.js`),
        import(`${SDK}/firebase-database.js`),
      ]);
    } catch {
      throw Object.assign(new Error("Firebase's code could not be downloaded."), { code: 'config/sdk-download' });
    }
    const app = appSdk.initializeApp(firebaseConfig);
    return { authSdk, dbSdk, auth: authSdk.getAuth(app), db: dbSdk.getDatabase(app) };
  })();
  starting.catch(() => (starting = null)); // try again next time
  return starting;
}

// The signed-in user once Firebase has checked (null when nobody is signed in).
function signedInUser(fb) {
  return new Promise(resolve => {
    let done = false;
    const stop = fb.authSdk.onAuthStateChanged(fb.auth, user => {
      if (done) return;
      done = true;
      resolve(user);
      setTimeout(() => stop());
    });
  });
}

// For students. Signs in anonymously unless someone (such as the host) is
// already signed in on this browser.
export async function connectStudent() {
  const fb = await start();
  if (!(await signedInUser(fb))) {
    anonymousSignIn ??= fb.authSdk.signInAnonymously(fb.auth).finally(() => (anonymousSignIn = null));
    await anonymousSignIn;
  }
  return database(fb);
}

// For the host page. user is null unless someone is signed in with email and
// password (an anonymous student sign-in on this browser doesn't count).
export async function hostAccount() {
  const fb = await start();
  const user = await signedInUser(fb);
  return {
    user: user && !user.isAnonymous ? user : null,
    signIn: async (email, password) => (await fb.authSdk.signInWithEmailAndPassword(fb.auth, email, password)).user,
    signOut: () => fb.authSdk.signOut(fb.auth),
    database: () => database(fb),
  };
}

// The few database actions group study uses. Paths are like "live" or
// "sessions/abc/participants".
function database(fb) {
  const { ref, onValue, get, set, update, serverTimestamp } = fb.dbSdk;
  const at = path => (path ? ref(fb.db, path) : ref(fb.db));
  return {
    get uid() {
      return fb.auth.currentUser?.uid ?? null;
    },
    // Calls onData with the value now and after every change; returns a function that stops it.
    watch: (path, onData, onError) => onValue(at(path), snap => onData(snap.val()), err => onError?.(err)),
    read: async path => (await get(at(path))).val(),
    write: (path, value) => set(at(path), value),
    // changes: { "child/path": value, ... }, all saved together or not at all.
    update: (path, changes) => update(at(path), changes),
    serverTime: () => serverTimestamp(),
  };
}

// Firebase problems in plain words, with what to check.
export function problemText(err) {
  const code = String(err?.code ?? '');
  const where = location.hostname;
  const messages = {
    'config/no-database-url': 'js/config.js is missing the databaseURL line. Copy the config again from the Firebase console (Project settings > Your apps) after creating the Realtime Database.',
    'config/sdk-download': "Firebase's code could not be downloaded. Check the internet connection and reload the page.",
    'auth/invalid-credential': "That email and password don't match the host account.",
    'auth/invalid-login-credentials': "That email and password don't match the host account.",
    'auth/wrong-password': "That email and password don't match the host account.",
    'auth/user-not-found': "That email and password don't match the host account.",
    'auth/invalid-email': "That doesn't look like an email address.",
    'auth/missing-password': 'Enter the password.',
    'auth/too-many-requests': 'Too many tries. Wait a few minutes, then try again.',
    'auth/network-request-failed': "Firebase can't be reached. Check the internet connection.",
    'auth/operation-not-allowed': 'This sign-in method is turned off. In the Firebase console, open Authentication > Sign-in method and enable both Email/Password and Anonymous.',
    'auth/admin-restricted-operation': 'Anonymous sign-in is turned off. In the Firebase console, open Authentication > Sign-in method and enable Anonymous.',
    'auth/configuration-not-found': 'Authentication is not set up in this Firebase project yet. In the Firebase console, open Authentication and click Get started.',
    'auth/unauthorized-domain': `Firebase doesn't accept sign-ins from ${where} yet. In the Firebase console, open Authentication > Settings > Authorized domains and add ${where}.`,
    'auth/invalid-api-key': 'The apiKey in js/config.js is not right. Copy the config again from the Firebase console.',
    'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'The apiKey in js/config.js is not right. Copy the config again from the Firebase console.',
    PERMISSION_DENIED: 'Firebase refused because of the database rules. Check that the rules from database.rules.json are published in the Firebase console (Realtime Database > Rules), with your User UID in place of PASTE_HOST_UID.',
  };
  return messages[code] ?? (err?.message ? `Firebase said: ${err.message}` : 'Something went wrong with Firebase.');
}

// ─────────────────────────────────────────────────────────────
//  Site settings. This is the only JS file you need to edit.
// ─────────────────────────────────────────────────────────────

// Name shown in the header of every page.
export const SITE_NAME = "Practice Exam Center";
export const SITE_TAGLINE = "Practice assessments for our nursing cohort";

// Group study (optional). The Firebase web config from the Firebase
// console (Project settings > Your apps). See README.md, "Turn on group
// study". Set it to null to switch group study off; solo practice works
// without it. These values aren't secret: the database rules protect the data.
export const firebaseConfig = {
  apiKey: "AIzaSyBlHEew3n_xJYJKk62UrOSBXL3usjEsKdE",
  authDomain: "practice-exam-center-cef47.firebaseapp.com",
  databaseURL: "https://practice-exam-center-cef47-default-rtdb.firebaseio.com",
  projectId: "practice-exam-center-cef47",
  storageBucket: "practice-exam-center-cef47.firebasestorage.app",
  messagingSenderId: "898459998049",
  appId: "1:898459998049:web:cc6f47414868d7b8c09720"
};

// Your host account's User UID. The host page shows it to you the
// first time you sign in. Only this account can run group sessions.
export const HOST_UID = "u4WL3CTLpcPA5iwNAWX60fnR7Jx2";

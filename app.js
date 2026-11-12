/* Collection amiibo — accès aux données avec Firebase (Authentication + Cloud Firestore).
   La configuration ci-dessous est publique par nature : la sécurité est assurée par les règles Firestore. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification,
  sendPasswordResetEmail, signOut, setPersistence, browserLocalPersistence, browserSessionPersistence,
  reauthenticateWithCredential, EmailAuthProvider, updatePassword, reload, connectAuthEmulator
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache, connectFirestoreEmulator,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, onSnapshot, writeBatch, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js';

/* ---------- Réglages ---------- */
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBsbGVjhZ2utFOxQ1op4_sH8ZURVgZaPes',
  authDomain: 'collection-amiibo.firebaseapp.com',
  projectId: 'collection-amiibo',
  storageBucket: 'collection-amiibo.firebasestorage.app',
  messagingSenderId: '553965182210',
  appId: '1:553965182210:web:cb9d963f9a28402e45f61b'
};
const OWNER_EMAIL = 'l.babindelignac@gmail.com';   // toujours admin (aussi dans les règles Firestore)
const ROLE_UI = { admin: 'admin', collection: 'edit', proche: 'read' };

/* ---------- Initialisation ---------- */
const EMU = new URLSearchParams(location.search).get('emu');   // tests locaux uniquement
const app = initializeApp(EMU ? { apiKey: 'demo', projectId: 'demo-amiibo', authDomain: 'localhost' } : FIREBASE_CONFIG);
const auth = getAuth(app);
auth.languageCode = 'fr';
let db;
try {
  db = initializeFirestore(app, { localCache: EMU ? memoryLocalCache() : persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch (e) {
  db = initializeFirestore(app, { localCache: memoryLocalCache() });
}
if (EMU) {
  connectAuthEmulator(auth, 'http://' + EMU + ':9099', { disableWarnings: true });
  connectFirestoreEmulator(db, EMU, 8080);
}

const siteUrl = () => location.origin + location.pathname;
const lower = s => String(s || '').trim().toLowerCase();
const fail = (msg, code) => { const e = new Error(msg); if (code) e.code = code; throw e; };

/* ---------- État ---------- */
let me = null;            // { email, name, role }
let subs = [];
let C = { meta: {}, series: new Map(), amiibos: new Map(), gifts: new Map() };
let loaded = {};
let pending = false;
let retried = false;   // une seule nouvelle tentative après rafraîchissement du jeton

function stop() {
  subs.forEach(u => { try { u(); } catch (e) { } });
  subs = []; me = null; loaded = {};
  C = { meta: {}, series: new Map(), amiibos: new Map(), gifts: new Map() };
}

function build() {
  const seeGifts = me.role === 'admin' || me.role === 'proche';
  const series = [...C.series.values()].sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(s => ({ id: s.id, name: s.name, row: s.id, items: [] }));
  const byId = new Map(series.map(s => [s.id, s]));
  [...C.amiibos.values()].sort((a, b) => (a.order || 0) - (b.order || 0)).forEach(a => {
    const s = byId.get(a.serieId); if (!s) return;
    const g = seeGifts ? C.gifts.get(a.id) : null;
    let gift = null;
    if (g) {
      const mine = lower(g.by) === me.email;
      gift = me.role === 'admin'
        ? { mine, by: mine ? 'vous' : (g.byName || g.by), date: g.at && g.at.toDate ? g.at.toDate().toLocaleDateString('fr-FR') : '' }
        : { mine };
    }
    s.items.push({
      row: a.id, num: a.num ?? '', name: a.name || '', owned: !!a.owned, img: a.img || '',
      nintendo: a.nintendo || '', shop: a.shop || '', vinted: a.vinted || '', vq: a.vq || '', gift
    });
  });
  return {
    role: ROLE_UI[me.role], seeGifts: me.role === 'admin', user: me.name, email: me.email,
    title: C.meta.title || 'Collection amiibo', owner: C.meta.owner || '', series
  };
}

function schedule() {
  if (pending) return; pending = true;
  setTimeout(() => {
    pending = false;
    if (!me) return;
    const need = ['meta', 'series', 'amiibos'].concat(me.role === 'collection' ? [] : ['gifts']);
    if (!need.every(k => loaded[k])) return;
    if (C.amiibos.size === 0 && me.role === 'admin') { UI.importSeed(); return; }
    UI.data(build());
  }, 0);
}

function listen(ref, key, onDoc) {
  subs.push(onSnapshot(ref, snap => {
    if (snap.docs) { const m = new Map(); snap.docs.forEach(d => m.set(d.id, Object.assign({ id: d.id }, d.data()))); C[key] = m; }
    else C[key] = snap.exists() ? snap.data() : {};
    loaded[key] = true; schedule();
  }, err => {
    console.error(key, err);
    if (err.code === 'permission-denied') {
      const u = auth.currentUser;
      if (u && !retried) { retried = true; u.getIdToken(true).then(() => handleUser(u)).catch(() => UI.noAccess(lower(u.email))); stop(); return; }
      UI.noAccess(me ? me.email : ''); stop();
    }
    else UI.toast('Connexion perdue, nouvel essai…', true);
  }));
}

/* ---------- Connexion ---------- */
async function handleUser(user) {
  stop();
  if (!user) { UI.login(); return; }
  if (!user.emailVerified) { UI.verify(user.email); return; }
  const email = lower(user.email);
  UI.loading();
  // Après la validation de l'e-mail, l'ancien jeton peut encore dire « non vérifié » : on le rafraîchit
  try {
    const tok = await user.getIdTokenResult();
    if (!tok.claims.email_verified) await user.getIdToken(true);
  } catch (e) { console.error(e); }
  let member = null;
  try {
    const snap = await getDoc(doc(db, 'members', email));
    if (snap.exists()) member = snap.data();
  } catch (e) { console.error(e); }
  let role = member && member.active !== false ? member.role : null;
  if (email === OWNER_EMAIL) role = 'admin';
  if (!ROLE_UI[role]) { UI.noAccess(email); return; }
  me = { email, role, name: (member && member.name) || (email === OWNER_EMAIL ? 'Laurent' : email) };
  if (member) updateDoc(doc(db, 'members', email), { lastLogin: serverTimestamp(), uid: user.uid }).catch(() => { });
  listen(doc(db, 'meta', 'config'), 'meta');
  listen(collection(db, 'series'), 'series');
  listen(collection(db, 'amiibos'), 'amiibos');
  if (role !== 'collection') listen(collection(db, 'gifts'), 'gifts');
}
onAuthStateChanged(auth, user => { handleUser(user).catch(e => { console.error(e); UI.toast(e.message, true); }); });

/* ---------- API utilisée par l'interface ---------- */
const amiibo = id => C.amiibos.get(id) || fail('Amiibo introuvable.');
const requireRole = (...r) => { if (!me || !r.includes(me.role)) fail('Vous n’avez pas le droit de faire cette modification.'); };

window.API = {
  async login(email, password, remember) {
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
    await signInWithEmailAndPassword(auth, lower(email), password);
  },
  async signup(email, password) {
    const cred = await createUserWithEmailAndPassword(auth, lower(email), password);
    await sendEmailVerification(cred.user, { url: siteUrl() });
    UI.verify(cred.user.email);
  },
  async recheck() {
    const u = auth.currentUser; if (!u) { UI.login(); return false; }
    await reload(u);
    if (!u.emailVerified) return false;
    await u.getIdToken(true);          // le jeton doit contenir email_verified = true pour les règles
    await handleUser(u);
    return true;
  },
  async resendVerification() {
    if (auth.currentUser) await sendEmailVerification(auth.currentUser, { url: siteUrl() });
  },
  async forgotPassword(email) {
    try { await sendPasswordResetEmail(auth, lower(email), { url: siteUrl() }); }
    catch (e) { if (e.code !== 'auth/user-not-found') throw e; }   // ne révèle pas si le compte existe
  },
  async logout() { await signOut(auth); },
  async changePassword(oldPassword, newPassword) {
    const u = auth.currentUser;
    if (String(newPassword).length < 8) fail('8 caractères minimum.');
    try { await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, oldPassword)); }
    catch (e) { fail('Mot de passe actuel incorrect.'); }
    await updatePassword(u, newPassword);
  },

  /* Collection */
  async setOwned(id, name, owned) {
    requireRole('admin', 'collection');
    await updateDoc(doc(db, 'amiibos', id), { owned: !!owned });
    return { row: id, owned: !!owned };
  },
  async reserveGift(id) {
    requireRole('admin', 'proche');
    const a = amiibo(id);
    if (a.owned) fail('Il a déjà cet amiibo.');
    if (C.gifts.has(id)) fail('Quelqu’un a déjà acheté cet amiibo.');
    const s = C.series.get(a.serieId);
    try {
      await setDoc(doc(db, 'gifts', id), { by: me.email, byName: me.name, at: serverTimestamp(), name: a.name, serie: s ? s.name : '' });
    } catch (e) { if (e.code === 'permission-denied') fail('Quelqu’un a déjà acheté cet amiibo.'); throw e; }
    return build();
  },
  async cancelGift(id) {
    requireRole('admin', 'proche');
    await deleteDoc(doc(db, 'gifts', id));
    return build();
  },
  async adminSetState(id, name, state) {
    requireRole('admin');
    const a = amiibo(id), b = writeBatch(db), hasGift = C.gifts.has(id);
    b.update(doc(db, 'amiibos', id), { owned: state === 'own' });
    if (state === 'bought' && !hasGift) {
      const s = C.series.get(a.serieId);
      b.set(doc(db, 'gifts', id), { by: me.email, byName: me.name, at: serverTimestamp(), name: a.name, serie: s ? s.name : '' });
    }
    if (state === 'miss' && hasGift) b.delete(doc(db, 'gifts', id));
    await b.commit();
    return build();
  },
  async setExtras(id, name, img, vq) {
    requireRole('admin');
    img = String(img || '').trim();
    if (img && !/^https?:\/\//.test(img)) fail("Le lien de l'image doit commencer par https://");
    await updateDoc(doc(db, 'amiibos', id), { img, vq: String(vq || '').trim() });
    return { row: id, img, vq };
  },
  async addAmiibo(p) {
    requireRole('admin');
    const name = String(p.name || '').trim(); if (!name) fail('Indiquez le nom de l’amiibo.');
    let serie = [...C.series.values()].find(s => s.name === p.series);
    const b = writeBatch(db);
    if (!serie && p.newSeries) {
      const n = String(p.newSeries).trim();
      if ([...C.series.values()].some(s => lower(s.name) === lower(n))) fail('Cette série existe déjà.');
      const ref = doc(collection(db, 'series'));
      serie = { id: ref.id, name: n, order: Math.max(0, ...[...C.series.values()].map(s => s.order || 0)) + 1 };
      b.set(ref, { name: serie.name, order: serie.order });
    }
    if (!serie) fail('Série introuvable.');
    const items = [...C.amiibos.values()].filter(a => a.serieId === serie.id);
    const nums = items.map(a => Number(a.num)).filter(n => !isNaN(n));
    const order = Math.max(0, ...items.map(a => a.order || 0)) + 1;
    const ref = doc(collection(db, 'amiibos'));
    const img = String(p.image || '').trim(), url = v => /^https?:\/\//.test(String(v || '').trim()) ? String(v).trim() : '';
    b.set(ref, {
      serieId: serie.id, order, num: nums.length ? Math.max(...nums) + 1 : 1, name, owned: !!p.owned,
      img: url(img), nintendo: url(p.nintendo), shop: url(p.nintendo) ? 'Boutique' : '', vinted: url(p.vinted), vq: String(p.vq || '').trim()
    });
    await b.commit();
    return build();
  },

  /* Comptes */
  async listAccounts() {
    requireRole('admin');
    const snap = await getDocs(collection(db, 'members'));
    const list = snap.docs.map(d => {
      const m = d.data();
      return {
        email: d.id, name: m.name || d.id, role: m.role || 'proche', active: m.active !== false,
        last: m.lastLogin && m.lastLogin.toDate ? m.lastLogin.toDate().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '',
        me: d.id === me.email, locked: d.id === OWNER_EMAIL
      };
    });
    if (!list.some(a => a.email === OWNER_EMAIL)) list.unshift({ email: OWNER_EMAIL, name: me.email === OWNER_EMAIL ? me.name : 'Propriétaire', role: 'admin', active: true, last: '', me: me.email === OWNER_EMAIL, locked: true });
    const rank = { admin: 0, collection: 1, proche: 2 };
    return list.sort((a, b) => (rank[a.role] - rank[b.role]) || a.name.localeCompare(b.name));
  },
  async saveAccount(p) {
    requireRole('admin');
    const email = lower(p.email), name = String(p.name || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('Adresse e-mail invalide.');
    if (!name) fail('Indiquez un nom.');
    if (!ROLE_UI[p.role]) fail('Rôle inconnu.');
    if (email === OWNER_EMAIL) fail('Le compte propriétaire ne peut pas être modifié.');
    if (email === me.email && (p.role !== 'admin' || p.active === false)) fail('Vous ne pouvez pas retirer vos propres droits d’admin.');
    const ref = doc(db, 'members', email);
    if (p.isNew) {
      const ex = await getDoc(ref);
      if (ex.exists()) fail('Un compte existe déjà avec cette adresse.');
      await setDoc(ref, { name, role: p.role, active: p.active !== false, createdAt: serverTimestamp() });
    } else {
      await updateDoc(ref, { name, role: p.role, active: p.active !== false });
    }
    return window.API.listAccounts();
  },
  async deleteAccount(email) {
    requireRole('admin');
    email = lower(email);
    if (email === me.email || email === OWNER_EMAIL) fail('Vous ne pouvez pas supprimer ce compte.');
    await deleteDoc(doc(db, 'members', email));
    return window.API.listAccounts();
  },

  /* Import initial (admin, base vide) : fichier JSON fourni à part, jamais publié sur GitHub */
  importSeed() {
    requireRole('admin');
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.json,application/json';
      input.onchange = async () => {
        try {
          const seed = JSON.parse(await input.files[0].text());
          if (!seed.amiibos || !seed.series) fail('Fichier non reconnu.');
          const ops = [];
          ops.push(['meta/config', seed.meta || {}]);
          seed.series.forEach(s => ops.push(['series/' + s.id, { name: s.name, order: s.order }]));
          seed.amiibos.forEach(a => { const { id, ...rest } = a; ops.push(['amiibos/' + id, rest]); });
          (seed.members || []).forEach(m => ops.push(['members/' + lower(m.email), { name: m.name, role: m.role, active: m.active !== false, createdAt: serverTimestamp() }]));
          const gifts = (seed.gifts || []).map(g => ['gifts/' + g.amiiboId, { by: lower(g.by), byName: g.byName || '', at: g.at ? new Date(g.at) : serverTimestamp(), name: g.name || '', serie: g.serie || '' }]);
          for (const list of [ops, gifts]) {          // les cadeaux après les amiibo
            for (let i = 0; i < list.length; i += 400) {
              const b = writeBatch(db);
              list.slice(i, i + 400).forEach(([path, data]) => b.set(doc(db, path), data));
              await b.commit();
            }
          }
          resolve(ops.length + gifts.length);
        } catch (e) { reject(e); }
      };
      input.click();
    });
  }
};

/* Conta Google e histórico na nuvem (Firebase Auth + Firestore).
   Estrutura no Firestore:
     users/{uid}                          → perfil (nome, e-mail, foto, último acesso)
     users/{uid}/draws/{drawId}           → sorteio completo em `json` + campos de resumo
     users/{uid}/draws/{drawId}/parts/{n} → lista de participantes em partes de até ~900 KB
   As regras de segurança (firestore.rules) só deixam cada usuário ler e gravar os próprios dados.
   Se este módulo não carregar (sem internet, por exemplo), o app segue funcionando só no navegador. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut,
  deleteUser, reauthenticateWithPopup,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore, doc, setDoc, getDocs, deleteDoc, collection, query, orderBy, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

// Configuração pública do app web (não é senha; o acesso é controlado pelas regras do Firestore).
const firebaseConfig = {
  apiKey: 'AIzaSyDkTNKUImABHSoSI8Qb9WFB9RJ2BJxXHX0',
  authDomain: 'sorteador-75b4b.firebaseapp.com',
  projectId: 'sorteador-75b4b',
  storageBucket: 'sorteador-75b4b.firebasestorage.app',
  messagingSenderId: '373164779957',
  appId: '1:373164779957:web:d20a9e0e3f41e8f0f451fc',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = 'pt-BR';
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

const PART_BYTES = 900_000; // limite do Firestore é 1 MiB por documento
const enc = new TextEncoder();

function uid() {
  if (!auth.currentUser) throw new Error('Entre com sua conta Google primeiro.');
  return auth.currentUser.uid;
}

const drawsCol = id => collection(db, 'users', id, 'draws');

// Divide a lista em textos JSON que cabem em um documento cada.
function chunk(items) {
  const parts = [];
  let cur = [], size = 2;
  for (const it of items) {
    const s = JSON.stringify(it);
    const bytes = enc.encode(s).length + 1;
    if (cur.length && size + bytes > PART_BYTES) { parts.push(`[${cur.join(',')}]`); cur = []; size = 2; }
    cur.push(s);
    size += bytes;
  }
  if (cur.length) parts.push(`[${cur.join(',')}]`);
  return parts;
}

const LOCAL_FIELDS = ['participants', 'owner', 'synced', 'participantsInCloud', 'participantsCount'];

const Cloud = {
  user: null,

  onChange(cb) {
    return onAuthStateChanged(auth, u => {
      Cloud.user = u ? { uid: u.uid, name: u.displayName || '', email: u.email || '', photo: u.photoURL || '' } : null;
      cb(Cloud.user);
    });
  },

  async signIn() {
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') return signInWithRedirect(auth, provider);
      throw e;
    }
  },

  signOut: () => signOut(auth),

  async touchProfile() {
    const u = auth.currentUser;
    await setDoc(doc(db, 'users', u.uid), {
      name: u.displayName || '', email: u.email || '', photo: u.photoURL || '', lastLogin: serverTimestamp(),
    }, { merge: true });
  },

  async saveDraw(rec) {
    const id = uid();
    const rest = { ...rec };
    LOCAL_FIELDS.forEach(k => delete rest[k]);
    const parts = rec.participants ? chunk(rec.participants) : [];
    const ref = doc(drawsCol(id), rec.id);
    // Primeiro as partes, depois o documento principal: se ele existe, a lista está completa.
    for (let i = 0; i < parts.length; i += 8) {
      const batch = writeBatch(db);
      parts.slice(i, i + 8).forEach((data, j) => batch.set(doc(ref, 'parts', String(i + j)), { i: i + j, data }));
      await batch.commit();
    }
    await setDoc(ref, {
      code: rec.code,
      title: rec.title,
      createdAt: rec.createdAt,
      kind: rec.kind || 'instagram',
      demo: !!rec.demo,
      entries: rec.eligibility?.entries ?? rec.pool?.size ?? 0,
      winners: rec.results.filter(r => r.role !== 'suplente').map(r => r.comment?.username ?? String(r.display ?? r.number)),
      parts: parts.length,
      participants: rec.participants ? rec.participants.length : 0,
      appVersion: rec.appVersion || null,
      json: JSON.stringify(rest),
      savedAt: serverTimestamp(),
    });
  },

  async listDraws() {
    const snap = await getDocs(query(drawsCol(uid()), orderBy('createdAt', 'desc')));
    return snap.docs.map(d => {
      const v = d.data();
      const rec = JSON.parse(v.json);
      rec.participantsInCloud = v.parts > 0;
      rec.participantsCount = v.participants || 0;
      return rec;
    });
  },

  async getParticipants(drawId) {
    const snap = await getDocs(collection(db, 'users', uid(), 'draws', drawId, 'parts'));
    return snap.docs.map(d => d.data()).sort((a, b) => a.i - b.i).flatMap(p => JSON.parse(p.data));
  },

  async deleteDraw(drawId) {
    const ref = doc(drawsCol(uid()), drawId);
    const parts = await getDocs(collection(ref, 'parts'));
    const batch = writeBatch(db);
    parts.docs.forEach(d => batch.delete(d.ref));
    batch.delete(ref);
    await batch.commit();
  },

  // Direito de eliminação (LGPD): apaga sorteios, perfil e o cadastro de login.
  async deleteAccount() {
    const u = auth.currentUser;
    if (!u) throw new Error('Entre com sua conta Google primeiro.');
    const draws = await getDocs(drawsCol(u.uid));
    for (const d of draws.docs) await Cloud.deleteDraw(d.id);
    await deleteDoc(doc(db, 'users', u.uid));
    try {
      await deleteUser(u);
    } catch (e) {
      if (e.code !== 'auth/requires-recent-login') throw e;
      await reauthenticateWithPopup(u, provider);
      await deleteUser(u);
    }
  },
};

window.Cloud = Cloud;
window.dispatchEvent(new Event('cloud:ready'));

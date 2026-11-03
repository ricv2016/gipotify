// Almacenamiento local (IndexedDB). Todo vive en el celular: nada sale a internet.
// Stores: tracks (metadatos), files (el audio como Blob), covers (carátulas), playlists.
const DB_NAME = 'gipotify';
const DB_VERSION = 2; // v2: store "sources" (carpetas enlazadas, p. ej. en la tarjeta SD)
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('covers')) db.createObjectStore('covers');
        if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const asPromise = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Transacción abortada'));
});

export async function getAll(store) {
  const db = await open();
  return asPromise(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await open();
  return asPromise(db.transaction(store).objectStore(store).get(key));
}

export async function put(store, value, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  if (key === undefined) os.put(value); else os.put(value, key);
  return done(tx);
}

export async function del(store, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

// Guarda canción + audio (+ carátula) en una sola transacción.
// blob = null para canciones enlazadas: el audio se lee de la carpeta original.
export async function addTrack(track, blob, cover) {
  const db = await open();
  const tx = db.transaction(['tracks', 'files', 'covers'], 'readwrite');
  if (blob) tx.objectStore('files').put(blob, track.id);
  if (cover) tx.objectStore('covers').put(cover.blob, cover.id);
  tx.objectStore('tracks').put(track);
  return done(tx);
}

export async function removeTrack(id) {
  const db = await open();
  const tx = db.transaction(['tracks', 'files'], 'readwrite');
  tx.objectStore('tracks').delete(id);
  tx.objectStore('files').delete(id);
  return done(tx);
}

export async function clearAll() {
  const db = await open();
  const stores = ['tracks', 'files', 'covers', 'playlists', 'sources'];
  const tx = db.transaction(stores, 'readwrite');
  stores.forEach((s) => tx.objectStore(s).clear());
  return done(tx);
}

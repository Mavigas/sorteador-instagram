/* Armazenamento local (IndexedDB) — sem limite prático de tamanho.
   Stores:
     draws  → cada sorteio realizado (registro completo, imutável)
     cache  → comentários já carregados por publicação, para retomar carregamentos longos */
const DB = (() => {
  const NAME = 'sorteador-instagram';
  const VERSION = 1;
  let opening;

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('draws')) {
          db.createObjectStore('draws', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('cache')) {
          db.createObjectStore('cache', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return opening;
  }

  async function run(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      let result;
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // Pede ao navegador para não apagar os dados automaticamente quando faltar espaço.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  return {
    put: (store, value) => run(store, 'readwrite', s => s.put(value)),
    get: (store, key) => run(store, 'readonly', s => s.get(key)),
    all: (store) => run(store, 'readonly', s => s.getAll()),
    del: (store, key) => run(store, 'readwrite', s => s.delete(key)),
    clear: (store) => run(store, 'readwrite', s => s.clear()),
    count: (store) => run(store, 'readonly', s => s.count()),
  };
})();

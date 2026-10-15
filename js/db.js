// お手本動画と骨格データを IndexedDB に保存する
const DB_NAME = 'ski-form';
const STORE = 'models';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export const listModels = () => run('readonly', (s) => s.getAll());
export const getModel = (id) => run('readonly', (s) => s.get(id));
export const saveModel = (model) => run('readwrite', (s) => s.put(model));
export const deleteModel = (id) => run('readwrite', (s) => s.delete(id));

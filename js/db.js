// お手本動画と骨格データを IndexedDB に保存する
import { DB_NAME } from './config.js';

const STORE = 'models';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('保存領域を開けませんでした'));
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req.result); };
    // 失敗すると error のあと abort が来る。WebKit では error の中身が空のことがある
    const fail = () => { db.close(); reject(tx.error ?? req.error ?? new Error('保存に失敗しました')); };
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

export const listModels = () => run('readonly', (s) => s.getAll());
export const getModel = (id) => run('readonly', (s) => s.get(id));
export const saveModel = (model) => run('readwrite', (s) => s.put(model));
export const deleteModel = (id) => run('readwrite', (s) => s.delete(id));

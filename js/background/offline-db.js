/**
 * Evidencias SQA — background/offline-db.js
 * Persistencia offline resiliente en IndexedDB (MV3 Service Worker).
 * Reemplaza chrome.storage.local {pendingCaptures: [{dataUrl base64}]}
 * por blobs binarios (~33% menos tamaño, sin serialización total en cada get/set).
 *
 * DB: SQAOfflineDB (v1)
 * Store: pendingCaptures
 *   keyPath: id (string: Date.now() + '-' + random)
 *   fields: id, blob (Blob), url, title, timestamp (ISO), browser, os, hasHeader (bool)
 *
 * Compatible: Chrome/Edge MV3 Service Worker (indexedDB disponible).
 * Preserva BUG-029 y flujos capture-visible/region/full/pdf.
 */

const DB_NAME = 'SQAOfflineDB';
const DB_VERSION = 1;
const STORE_NAME = 'pendingCaptures';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => console.warn('[OfflineDB] open blocked');
    });
}

async function withStore(mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const result = fn(store, tx);
        // Si fn retorna promise, encadenar
        if (result && typeof result.then === 'function') {
            result.then(resolve).catch(reject);
        }
        tx.oncomplete = () => {
            try { db.close(); } catch {}
            if (!result || typeof result.then !== 'function') resolve(result);
        };
        tx.onerror = () => {
            try { db.close(); } catch {}
            reject(tx.error);
        };
        tx.onabort = () => {
            try { db.close(); } catch {}
            reject(tx.error || new Error('tx aborted'));
        };
    });
}

export async function addPendingCapture({ id, blob, url, title, timestamp, browser, os, hasHeader }) {
    if (!blob || !(blob instanceof Blob)) throw new Error('addPendingCapture: blob requerido');
    if (!id) id = Date.now() + '-' + Math.round(Math.random() * 1000000);
    const record = { id, blob, url: url || '', title: title || 'Captura SQA', timestamp: timestamp || new Date().toISOString(), browser: browser || '', os: os || '', hasHeader: !!hasHeader };
    await withStore('readwrite', (store) => {
        return new Promise((res, rej) => {
            const r = store.add(record);
            r.onsuccess = () => res();
            r.onerror = () => rej(r.error);
        });
    });
    return id;
}

export async function getAllPendingCaptures() {
    return withStore('readonly', (store) => {
        return new Promise((res, rej) => {
            const r = store.getAll();
            r.onsuccess = () => res(r.result || []);
            r.onerror = () => rej(r.error);
        });
    });
}

export async function countPendingCaptures() {
    return withStore('readonly', (store) => {
        return new Promise((res, rej) => {
            const r = store.count();
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
    });
}

export async function deletePendingCapture(id) {
    await withStore('readwrite', (store) => {
        return new Promise((res, rej) => {
            const r = store.delete(id);
            r.onsuccess = () => res();
            r.onerror = () => rej(r.error);
        });
    });
}

export async function clearPendingCaptures() {
    await withStore('readwrite', (store) => {
        return new Promise((res, rej) => {
            const r = store.clear();
            r.onsuccess = () => res();
            r.onerror = () => rej(r.error);
        });
    });
}

export async function deleteMany(ids) {
    await withStore('readwrite', (store) => {
        return new Promise((res, rej) => {
            let pending = ids.length;
            if (pending === 0) return res();
            let error = null;
            ids.forEach(id => {
                const r = store.delete(id);
                r.onsuccess = () => { if (--pending === 0) error ? rej(error) : res(); };
                r.onerror = () => { error = r.error; if (--pending === 0) rej(error); };
            });
        });
    });
}

/**
 * Migración 1 vez: lee chrome.storage.local {pendingCaptures: [{dataUrl}]} (legacy)
 * convierte dataUrl -> Blob y migra a IndexedDB.
 * Idempotente y best-effort. Borra clave legacy solo si migración exitosa.
 */
export async function migrateFromStorageLocal(getBlobFromDataUrlFn) {
    try {
        const result = await chrome.storage.local.get({ pendingCaptures: [] });
        const pending = result.pendingCaptures || [];
        if (!Array.isArray(pending) || pending.length === 0) return 0;

        // Verificar si ya migrado (IndexedDB ya tiene datos -> no duplicar)
        const existing = await countPendingCaptures().catch(() => 0);
        if (existing > 0) {
            // Ya hay datos en IndexedDB, asumir migración previa; limpiar legacy sin duplicar
            await chrome.storage.local.remove('pendingCaptures').catch(() => {});
            return 0;
        }

        let migrated = 0;
        for (const cap of pending) {
            try {
                if (!cap.dataUrl) continue;
                const blob = await getBlobFromDataUrlFn(cap.dataUrl);
                if (!blob) continue;
                await addPendingCapture({
                    id: cap.id || (Date.now() + '-' + Math.round(Math.random() * 1000000)),
                    blob,
                    url: cap.url || '',
                    title: cap.title || 'Captura SQA',
                    timestamp: cap.timestamp || new Date().toISOString(),
                    browser: cap.browser || '',
                    os: cap.os || '',
                    hasHeader: !!cap.hasHeader
                });
                migrated++;
            } catch (e) {
                console.warn('[OfflineDB] migrate item skip', e.message);
            }
        }
        if (migrated > 0) {
            await chrome.storage.local.remove('pendingCaptures').catch(() => {});
            console.log(`[OfflineDB] Migración completada: ${migrated}/${pending.length} capturas migradas de storage.local → IndexedDB`);
        } else if (pending.length > 0) {
            // Si nada migró, no borrar para reintentar luego
            console.warn('[OfflineDB] Migración sin éxito, se conserva storage.local');
            return 0;
        } else {
            await chrome.storage.local.remove('pendingCaptures').catch(() => {});
        }
        return migrated;
    } catch (err) {
        console.warn('[OfflineDB] migrateFromStorageLocal error', err.message);
        return 0;
    }
}

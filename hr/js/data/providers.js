/* PRD-HR V8 — DataProvider contract + two implementations.
   Contract (all async): open, get(store,key), put(store,rec), putMany(store,recs), delete(store,key),
   list(store,{index,value,limit}), count(store), clear(store), append(store,rec).
   MemoryProvider  -> tests / fallback.   IndexedDBProvider -> V8 Demo persistence.
   A future FirebaseProvider only has to implement the same methods; no UI/service code changes. */
(function (g) {
  const NS = (g.PRDHR = g.PRDHR || {});
  const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
  const dig = (o, p) => (o == null ? undefined : o[p]);

  function guardAppendOnly(def, op) { if (def.appendOnly) throw new Error("STORE_APPEND_ONLY: " + def.name + " does not allow " + op); }

  class MemoryProvider {
    constructor() { this.kind = "memory"; this.data = {}; }
    async open() { for (const s of NS.schema) this.data[s.name] = this.data[s.name] || new Map(); return this; }
    _def(n) { const d = NS.schemaByName[n]; if (!d) throw new Error("UNKNOWN_STORE: " + n); return d; }
    async get(n, k) { const v = this.data[n].get(k); return v === undefined ? null : clone(v); }
    async put(n, r) {
      const d = this._def(n), k = r[d.keyPath];
      if (k === undefined || k === null || k === "") throw new Error("KEY_MISSING: " + n + "." + d.keyPath);
      if (d.appendOnly && this.data[n].has(k)) guardAppendOnly(d, "overwrite");
      this.data[n].set(k, clone(r)); return k;
    }
    async putMany(n, rs) { for (const r of rs) await this.put(n, r); return rs.length; }
    async delete(n, k) { guardAppendOnly(this._def(n), "delete"); this.data[n].delete(k); }
    async list(n, o) {
      o = o || {}; let out = [...this.data[n].values()];
      if (o.index) out = out.filter((r) => dig(r, NS.schemaByName[n].indexes.find((i) => i.name === o.index).keyPath) === o.value);
      if (o.limit) out = out.slice(0, o.limit); return clone(out);
    }
    async count(n) { return this.data[n].size; }
    async clear(n) { guardAppendOnly(this._def(n), "clear"); this.data[n].clear(); }
    async append(n, r) { const d = this._def(n); if (!d.appendOnly) throw new Error("NOT_APPEND_STORE: " + n); return this.put(n, r); }
  }

  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error("TX_ABORT")); });

  class IndexedDBProvider {
    constructor(name) { this.kind = "indexeddb"; this.name = name || NS.DB_NAME; this.db = null; }
    async open() {
      if (this.db) return this;
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open(this.name, NS.SCHEMA_VERSION);
        r.onupgradeneeded = () => {
          const db = r.result;
          for (const s of NS.schema) {
            if (db.objectStoreNames.contains(s.name)) continue;
            const st = db.createObjectStore(s.name, { keyPath: s.keyPath });
            for (const i of s.indexes) st.createIndex(i.name, i.keyPath, { unique: !!i.unique });
          }
        };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error("IDB_BLOCKED"));
      });
      return this;
    }
    _def(n) { const d = NS.schemaByName[n]; if (!d) throw new Error("UNKNOWN_STORE: " + n); return d; }
    async get(n, k) { const v = await req(this.db.transaction(n).objectStore(n).get(k)); return v === undefined ? null : v; }
    async put(n, r) {
      const d = this._def(n), k = r[d.keyPath];
      if (k === undefined || k === null || k === "") throw new Error("KEY_MISSING: " + n + "." + d.keyPath);
      const tx = this.db.transaction(n, "readwrite"), st = tx.objectStore(n);
      if (d.appendOnly) { const ex = await req(st.getKey(k)); if (ex !== undefined) { tx.abort(); guardAppendOnly(d, "overwrite"); } }
      st.put(clone(r)); await txDone(tx); return k;
    }
    async putMany(n, rs) { // single transaction -> all-or-nothing
      const d = this._def(n); guardAppendOnly(d, "putMany");
      const tx = this.db.transaction(n, "readwrite"), st = tx.objectStore(n);
      for (const r of rs) { if (!r[d.keyPath]) { tx.abort(); throw new Error("KEY_MISSING: " + n); } st.put(clone(r)); }
      await txDone(tx); return rs.length;
    }
    async delete(n, k) { guardAppendOnly(this._def(n), "delete"); const tx = this.db.transaction(n, "readwrite"); tx.objectStore(n).delete(k); await txDone(tx); }
    async list(n, o) {
      o = o || {}; const st = this.db.transaction(n).objectStore(n);
      return o.index ? req(st.index(o.index).getAll(o.value, o.limit)) : req(st.getAll(undefined, o.limit));
    }
    async count(n) { return req(this.db.transaction(n).objectStore(n).count()); }
    async clear(n) { guardAppendOnly(this._def(n), "clear"); const tx = this.db.transaction(n, "readwrite"); tx.objectStore(n).clear(); await txDone(tx); }
    async append(n, r) { const d = this._def(n); if (!d.appendOnly) throw new Error("NOT_APPEND_STORE: " + n); return this.put(n, r); }
    close() { if (this.db) { this.db.close(); this.db = null; } }
  }

  NS.MemoryProvider = MemoryProvider; NS.IndexedDBProvider = IndexedDBProvider;
  NS.createProvider = async (opts) => {
    opts = opts || {};
    const p = !opts.memory && typeof indexedDB !== "undefined" ? new IndexedDBProvider(opts.name) : new MemoryProvider();
    return p.open();
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
if (typeof module !== "undefined") module.exports = globalThis.PRDHR;

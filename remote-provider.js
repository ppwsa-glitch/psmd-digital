/* PRD-HR V8 — RemoteProvider: DataProvider ដែលនិយាយជាមួយ Backend (HRWeb.gs, Google Apps Script + Google Sheet)
   ប្រើ Contract ដូច IndexedDBProvider (open/get/put/putMany/delete/list/count/clear/append) ដូច្នេះ Service/UI មិនត្រូវកែច្រើន។
   - Identity មកពី Server (Session របស់ Hub) — មិនមាន «ដើរតួ» ក្នុង Browser ទៀតទេ
   - Server ជាអ្នកបង្ខំ Role/Scope/Mask/State machine/Audit; ឯនេះគ្រាន់តែជា Cache + UX
   - Cache ក្នុង Memory ក្នុងមួយ Store (ផ្ទុកពេលប្រើដំបូង, ផុត 60 វិនាទី) → សរសេរ Cache ឡើងវិញពីចម្លើយ Server
   - Audit: ដាក់ជួរ (Queue) ផ្ញើជា Batch; Module រសើប (security/settings/documents) ផ្ញើភ្លាម */
(function (g) {
  const NS = (g.PRDHR = g.PRDHR || {});
  const CFG = () => g.PRDHR_CONFIG || {};
  const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
  const HUB_KEY = "psmd_digital_session_v1", HR_KEY = "prdhr_session_v1";
  const SYNC_AUDIT_MODULES = ["security", "settings", "documents"];

  /* ---------- Session ពី Hub: #psmd_session=… (រួចលុបចេញពី URL មុន Router ដំណើរការ) ---------- */
  (function takeSessionFromHash() {
    try {
      const m = /[#&]psmd_session=([^&]+)/.exec(location.hash || "");
      if (m) { sessionStorage.setItem(HR_KEY, decodeURIComponent(m[1])); history.replaceState(null, "", location.pathname + location.search); }
    } catch (e) { /* ignore */ }
  })();
  NS.hrSession = () => { try { return sessionStorage.getItem(HR_KEY) || localStorage.getItem(HUB_KEY) || ""; } catch (e) { return ""; } };
  NS.hrLogout = () => { try { sessionStorage.removeItem(HR_KEY); } catch (e) { /* ignore */ } location.replace(CFG().HUB_URL || "../index.html"); };

  /* ---------- ទំព័រ Gate (មិនអាចប្រើបាន) ---------- */
  const GATE = {
    no_session: ["🔐", "សូមចូលប្រើតាម Hub ជាមុន", "Please sign in through the Hub first."],
    session_invalid: ["⏱", "សម័យចូលប្រើផុតកំណត់", "សូមចូលម្តងទៀតតាម Hub។"],
    not_registered: ["🔒", "គណនីរបស់អ្នកមិនទាន់មានសិទ្ធិប្រើ PRD-HR ទេ", "សូមទាក់ទង HR Administrator ដើម្បីបន្ថែមអ្នកក្នុង «អ្នកប្រើ & សិទ្ធិ» (ភ្ជាប់ជាមួយលេខសម្គាល់បុគ្គលិក Hub របស់អ្នក)។"],
    must_change_pin: ["🔑", "សូមកំណត់ពាក្យសម្ងាត់ផ្ទាល់ខ្លួននៅ Hub ជាមុន", "Please set your own password in the Hub first."],
    no_staff_id: ["⚠️", "គណនី Hub របស់អ្នកគ្មានលេខសម្គាល់បុគ្គលិក", "សូមទាក់ទងអ្នកគ្រប់គ្រងប្រព័ន្ធ។"],
    server_not_configured: ["🛠", "Backend មិនទាន់កំណត់រួចរាល់", "ត្រូវដំណើរការ setupHR() ហើយដាក់ Script Properties (មើល SETUP-KH.md)។"],
    hub_unreachable: ["📡", "មិនអាចទាក់ទង Hub ដើម្បីផ្ទៀងផ្ទាត់បាន", "សូមព្យាយាមម្តងទៀតបន្តិចក្រោយ។"],
    network: ["📡", "មិនអាចភ្ជាប់ទៅម៉ាស៊ីនបម្រើបានទេ", "សូមពិនិត្យអ៊ីនធឺណិត រួចព្យាយាមម្តងទៀត។"],
  };
  NS.GATE_CODES = Object.keys(GATE);
  NS.gate = function (code, err) {
    const [ic, t, d] = GATE[code] || ["⚠️", "មានបញ្ហា", (err && err.message) || String(code)];
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    document.body.innerHTML = `<div style="min-height:100vh;display:grid;place-items:center;padding:24px;font-family:system-ui,'Kantumruy Pro','Noto Sans Khmer',sans-serif;background:#EAF1F3;color:#12323f"><div style="max-width:460px;text-align:center;background:#fff;border-radius:18px;padding:32px 26px;box-shadow:0 10px 30px rgba(20,90,200,.15)"><div style="font-size:44px">${ic}</div><h2 style="margin:10px 0 6px;font-size:1.15rem">${esc(t)}</h2><p style="margin:0 0 18px;color:#4a6572;line-height:1.7">${esc(d)}</p><button id="gt-retry" style="margin-right:8px;padding:9px 16px;border:0;border-radius:10px;background:#1565d8;color:#fff;font:inherit;cursor:pointer">ព្យាយាមម្តងទៀត</button><a href="${esc(CFG().HUB_URL || "../index.html")}" style="display:inline-block;padding:9px 16px;border-radius:10px;background:#e3edf3;color:#12323f;text-decoration:none">ទៅ Hub</a></div></div>`;
    document.getElementById("gt-retry").onclick = () => location.reload();
  };

  /* ---------- Provider ---------- */
  class RemoteProvider {
    constructor(o) {
      this.kind = "remote"; this.serverAudit = true; this.url = o.apiUrl; this.ttl = o.ttl || 60000;
      this.cache = new Map(); this.loaded = {}; this.pend = {}; this.aq = []; this.fl = null; this.identity = null; this.hub = null;
      this.onAuthLost = null;
    }
    /* --- transport --- */
    async call(action, payload, ms) {
      const sess = NS.hrSession(); if (!sess) { const e = new Error("NO_SESSION"); e.code = "no_session"; throw e; }
      const ac = new AbortController(), tm = setTimeout(() => ac.abort(), ms || 60000);
      let res;
      try { const r = await fetch(this.url, { method: "POST", redirect: "follow", signal: ac.signal, body: JSON.stringify({ action, initData: "", browserSession: sess, payload: payload || {} }) }); res = await r.json(); }
      catch (e) { const x = new Error(e.name === "AbortError" ? "TIMEOUT: ចំណាយពេលយូរពេក" : "NETWORK: មិនអាចភ្ជាប់ទៅម៉ាស៊ីនបម្រើបានទេ"); x.code = "network"; throw x; }
      finally { clearTimeout(tm); }
      if (res && res.ok) return res;
      const code = (res && res.error) || "server_error", e = new Error(code === "forbidden" ? "FORBIDDEN: " + (res.detail || "") : code + (res && res.detail ? ": " + res.detail : ""));
      e.code = code === "forbidden" ? "FORBIDDEN" : code; e.detail = (res && res.detail) || ""; e.payload = res;
      if (["session_invalid", "not_registered", "must_change_pin", "no_staff_id", "server_not_configured", "hub_unreachable"].includes(code) && this.onAuthLost) this.onAuthLost(code, e);
      throw e;
    }
    async open() {
      const w = await this.call("hrWhoAmI", {});
      this.identity = w.user; this.hub = w.hub; this.roles = w.roles;
      await Promise.all(["employees", "system_settings", "roles"].map((s) => this._load(s)));
      return this;
    }
    /* --- cache --- */
    _def(n) { const d = NS.schemaByName[n]; if (!d) throw new Error("UNKNOWN_STORE: " + n); return d; }
    _fresh(n) { const L = this.loaded[n]; return !!L && Date.now() - L < this.ttl; }
    async _load(n, force) {
      if (!force && this._fresh(n)) return;
      if (this.pend[n]) return this.pend[n];
      const kp = this._def(n).keyPath;
      return (this.pend[n] = this.call("hrList", { store: n }, 90000).then((r) => {
        this.cache.set(n, new Map(r.items.map((x) => [x[kp], x]))); this.loaded[n] = Date.now();
      }).finally(() => { delete this.pend[n]; }));
    }
    _store(n) { if (!this.cache.has(n)) this.cache.set(n, new Map()); return this.cache.get(n); }
    invalidate(n) { if (n) delete this.loaded[n]; else this.loaded = {}; }
    async refresh(n) { return this._load(n, true); }
    /* --- contract --- */
    async get(n, k) {
      const d = this._def(n), m = this.cache.get(n);
      if (m && m.has(k)) return clone(m.get(k));
      if (m && this._fresh(n)) return null;
      const r = await this.call("hrGet", { store: n, key: k });
      if (r.item) this._store(n).set(r.item[d.keyPath], r.item);
      return r.item ? clone(r.item) : null;
    }
    async list(n, o) {
      o = o || {}; await this._load(n); let out = [...this._store(n).values()];
      if (o.index) { const kp = this._def(n).indexes.find((i) => i.name === o.index).keyPath; out = out.filter((r) => r[kp] === o.value); }
      if (o.limit) out = out.slice(0, o.limit);
      return clone(out);
    }
    async count(n) { await this._load(n); return this._store(n).size; }
    async put(n, rec) {
      const d = this._def(n), k = rec[d.keyPath];
      if (k === undefined || k === null || k === "") throw new Error("KEY_MISSING: " + n + "." + d.keyPath);
      if (d.appendOnly) throw new Error("STORE_APPEND_ONLY: " + n + " does not allow overwrite");
      const r = await this.call("hrPut", { store: n, rec }, n === "documents" ? 150000 : 60000);
      this._store(n).set(k, r.rec); return k;
    }
    async putMany(n, recs) {
      const d = this._def(n); if (d.appendOnly) throw new Error("STORE_APPEND_ONLY: " + n + " does not allow putMany");
      for (const r of recs) if (!r[d.keyPath]) throw new Error("KEY_MISSING: " + n);
      for (let i = 0; i < recs.length; i += 400) await this.call("hrPutMany", { store: n, recs: recs.slice(i, i + 400) }, 120000);
      this.invalidate(n); return recs.length;   // Server អាចកែតម្រូវ Record → ផ្ទុកឡើងវិញពេលអានលើកក្រោយ
    }
    async delete(n, k) {
      if (this._def(n).appendOnly) throw new Error("STORE_APPEND_ONLY: " + n + " does not allow delete");
      await this.call("hrDelete", { store: n, key: k }); this._store(n).delete(k);
    }
    async clear() { throw new Error("CLEAR_DISABLED: Backend មិនអនុញ្ញាតលុបទាំង Store"); }
    async append(n, rec) { if (n === "audit_logs") return this.appendAudit(rec); throw new Error("NOT_APPEND_STORE: " + n); }
    /* --- audit (Server ជាអ្នកកំណត់ seq/hash/user/ts) --- */
    appendAudit(e) {
      const rec = { action: e.action, module: e.module, employee_id: e.employee_id || null, previous: e.previous === undefined ? null : e.previous, next: e.next === undefined ? null : e.next, result: e.result || "ok", note: e.note || null };
      this.aq.push(rec);
      if (SYNC_AUDIT_MODULES.includes(rec.module) || this.aq.length >= 250) return this.flushAudit();
      clearTimeout(this._at); this._at = setTimeout(() => this.flushAudit().catch(() => {}), 400);
      return Promise.resolve({ queued: true });
    }
    flushAudit() {
      if (this.fl) return this.fl.then(() => (this.aq.length ? this.flushAudit() : null));
      clearTimeout(this._at);
      const run = async () => {
        while (this.aq.length) {
          const batch = this.aq.slice(0, 250);
          await this.call("hrAppendAudit", { entries: batch });   // បរាជ័យ → នៅក្នុង Queue សម្រាប់ព្យាយាមម្តងទៀត
          this.aq.splice(0, batch.length); this.invalidate("audit_logs");
        }
      };
      return (this.fl = run().finally(() => { this.fl = null; }));
    }
    async verifyAudit() { await this.flushAudit(); return (await this.call("hrVerifyAudit", {})).result; }
    async getFile(id) { return (await this.call("hrGetFile", { id }, 150000)).file; }
    async readSource() { return (await this.call("hrReadSource", {}, 120000)).file; }   // Staff_List ពី Google Sheet ប្រភព (Server អានតម្លៃ Raw)
  }

  NS.RemoteProvider = RemoteProvider;
  NS.remoteConfigured = () => !!String(CFG().API_URL || "").trim();
  const baseCreate = NS.createProvider;
  NS.createProvider = async (opts) => {
    opts = opts || {};
    if (!opts.memory && NS.remoteConfigured()) {
      if (!NS.hrSession()) { const e = new Error("NO_SESSION"); e.code = "no_session"; throw e; }
      const p = new RemoteProvider({ apiUrl: CFG().API_URL.trim() });
      p.onAuthLost = (code, e) => { if (!NS._gated) { NS._gated = true; NS.gate(code, e); } };
      await p.open(); NS.remote = p;
      /* ផ្ញើ Audit ដែលនៅសល់ពេលបិទ/លាក់ Tab */
      const bye = () => { if (p.aq.length) { try { fetch(p.url, { method: "POST", keepalive: true, body: JSON.stringify({ action: "hrAppendAudit", initData: "", browserSession: NS.hrSession(), payload: { entries: p.aq.slice(0, 100) } }) }); } catch (e) { /* ignore */ } } };
      addEventListener("pagehide", bye);
      return p;
    }
    return baseCreate(opts);
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
if (typeof module !== "undefined") module.exports = globalThis.PRDHR;

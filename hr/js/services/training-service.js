/* PRD-HR V8 — Training & Development (Phase 4b-2). No training data exists in the Excel, so everything here is HR-entered; the 40h target is a configurable Demo parameter, not an official requirement. */
(function (g) {
  const NS = (g.PRDHR = g.PRDHR || {}), { calc, dates } = NS, fail = (code, msg) => ({ ok: false, errors: [{ code, msg }] });
  NS.TRAINING_STATUS = { planned: "គ្រោងទុក", ongoing: "កំពុងដំណើរការ", completed: "បានបញ្ចប់", cancelled: "លុបចោល" };
  NS.PARTICIPANT_STATUS = { enrolled: "បានចុះឈ្មោះ", completed: "បានបញ្ចប់", absent: "អវត្តមាន" };
  const bump = (o, k, n) => { o[k] = (o[k] || 0) + n; };

  class TrainingService {
    constructor(p, audit, emp, settings) { this.p = p; this.audit = audit; this.emp = emp; this.st = settings; }
    async target() { return (await this.st.get("trainingTargetHours", null)) || NS.defaultConfig().training.annualTargetHours; }
    async setTarget(user, h) { if (!(h > 0 && h <= 500)) return fail("TARGET", "គោលដៅត្រូវនៅចន្លោះ 1–500 ម៉ោង"); await this.st.set(user, "trainingTargetHours", h); return { ok: true }; }
    courses() { return this.p.list("training_courses").then((l) => l.sort((a, b) => (a.start_date < b.start_date ? 1 : -1))); }
    async createCourse(user, d) {
      NS.policy.assert(user, "create"); const title = (d.title || "").trim(), hours = Number(d.hours); if (!title) return fail("TITLE", "ត្រូវមានឈ្មោះវគ្គ"); if (!dates.toDate(d.start_date) || !dates.toDate(d.end_date)) return fail("DATE", "កាលបរិច្ឆេទមិនត្រឹមត្រូវ");
      if (!NS.validators.dateRange(d.start_date, d.end_date)) return fail("DATE_RANGE", "ថ្ងៃបញ្ចប់ត្រូវមិនមុនថ្ងៃចាប់ផ្តើម"); if (!(hours > 0 && hours <= 1000)) return fail("HOURS", "ម៉ោងត្រូវនៅចន្លោះ 1–1000");
      if ((await this.courses()).some((c) => c.title === title && c.start_date === d.start_date)) return fail("DUPLICATE", "មានវគ្គដូចគ្នារួចហើយ");
      const c = { id: NS.uid(), title, category: d.category || null, provider: d.provider || null, location: d.location || null, start_date: d.start_date, end_date: d.end_date, hours, status: "planned", origin: "manual", created_at: NS.clock.nowISO(), created_by: user.id || user.role };
      await this.p.put("training_courses", c); await this.audit.log({ user, action: "course-create", module: "training", next: { title, hours, start: c.start_date } }); return { ok: true, id: c.id };
    }
    async setCourseStatus(user, id, status) {
      NS.policy.assert(user, "edit"); if (!NS.TRAINING_STATUS[status]) return fail("STATUS", "ស្ថានភាពមិនត្រឹមត្រូវ"); const c = await this.p.get("training_courses", id); if (!c) return fail("NOT_FOUND", "រកមិនឃើញវគ្គ");
      const prev = c.status; c.status = status; await this.p.put("training_courses", c); await this.audit.log({ user, action: "course-status", module: "training", previous: { status: prev }, next: { status }, note: c.title }); return { ok: true };
    }
    async enroll(user, courseId, ids) {
      NS.policy.assert(user, "edit"); const c = await this.p.get("training_courses", courseId); if (!c) return fail("NOT_FOUND", "រកមិនឃើញវគ្គ"); if (c.status === "cancelled") return fail("CANCELLED", "វគ្គត្រូវបានលុបចោល");
      const list = [...new Set(ids.map(NS.validators.normalizeId).filter(Boolean))]; if (!list.length) return fail("EMPTY", "មិនមានបុគ្គលិកត្រូវចុះឈ្មោះ");
      for (const id of list) { if (!(await this.p.get("employees", id))) return fail("EMPLOYEE_NOT_FOUND", "រកមិនឃើញ " + id); if (await this.p.get("training_participants", courseId + "|" + id)) return fail("ALREADY", id + " បានចុះឈ្មោះរួចហើយ"); }
      for (const id of list) await this.p.put("training_participants", { id: courseId + "|" + id, course_id: courseId, employee_id: id, status: "enrolled", certificate_no: null, certificate_expiry: null, created_at: NS.clock.nowISO() });
      await this.audit.log({ user, action: "course-enroll", module: "training", note: `${c.title}: ${list.length} នាក់` }); return { ok: true, n: list.length };
    }
    async mark(user, courseId, empId, d) {
      NS.policy.assert(user, "edit"); const r = await this.p.get("training_participants", courseId + "|" + empId), c = await this.p.get("training_courses", courseId); if (!r || !c) return fail("NOT_FOUND", "រកមិនឃើញអ្នកចូលរួម"); if (!NS.PARTICIPANT_STATUS[d.status]) return fail("STATUS", "ស្ថានភាពមិនត្រឹមត្រូវ");
      if (d.status === "completed" && c.start_date > dates.iso(NS.clock.today())) return fail("NOT_STARTED", "វគ្គមិនទាន់ចាប់ផ្តើម មិនអាចសម្គាល់ថាបានបញ្ចប់");
      if (d.certificate_expiry && !dates.toDate(d.certificate_expiry)) return fail("EXPIRY", "ថ្ងៃផុតកំណត់មិនត្រឹមត្រូវ"); if (d.certificate_expiry && d.certificate_expiry < c.end_date) return fail("EXPIRY", "ថ្ងៃផុតកំណត់ត្រូវមិនមុនថ្ងៃបញ្ចប់វគ្គ");
      const prev = r.status; Object.assign(r, { status: d.status, certificate_no: d.certificate_no || r.certificate_no, certificate_expiry: d.certificate_expiry || r.certificate_expiry }); await this.p.put("training_participants", r);
      await this.audit.log({ user, action: "participant-mark", module: "training", employee_id: empId, previous: { status: prev }, next: { status: d.status }, note: c.title }); return { ok: true };
    }
    /* analytics (scoped by employee visibility): credited hours = course hours of COMPLETED participations whose course ended in the year */
    async analytics(user, year) {
      const emps = (await this.emp.list(user, { pageSize: 100000 })).items, by = Object.fromEntries(emps.map((e) => [e.employee_id, e])), parts = await this.emp.relatedAll(user, "training_participants"), cs = Object.fromEntries((await this.courses()).map((c) => [c.id, c])), target = await this.target();
      const hours = {}, history = [], off = {}; let total = 0;
      for (const r of parts) { const c = cs[r.course_id]; if (!c || r.status !== "completed" || c.status === "cancelled" || c.end_date.slice(0, 4) !== String(year)) continue; bump(hours, r.employee_id, c.hours); total += c.hours; }
      for (const [id, h] of Object.entries(hours)) { const o = (by[id] || {}).unit_text || "មិនបានបញ្ជាក់"; (off[o] = off[o] || { hours: 0, people: 0 }).hours += h; off[o].people++; }
      const people = Object.keys(hours).length; return { year, target, targetOfficial: false, total, people, visible: emps.length, participationRate: emps.length && Object.keys(cs).length ? Math.round((people / emps.length) * 1000) / 10 : null,
        byEmployee: emps.map((e) => ({ employee_id: e.employee_id, name_km: e.name_km, office: e.unit_text, hours: hours[e.employee_id] || 0, pct: Math.round(((hours[e.employee_id] || 0) / target) * 100) })).sort((a, b) => a.hours - b.hours || (a.employee_id < b.employee_id ? -1 : 1)),
        byOffice: Object.entries(off).map(([o, v]) => ({ office: o, hours: v.hours, people: v.people, avg: Math.round((v.hours / v.people) * 10) / 10 })).sort((a, b) => b.hours - a.hours), metTarget: Object.values(hours).filter((h) => h >= target).length, courses: Object.keys(cs).length };
    }
    async history(user, empId) { const rs = await this.emp.related(user, empId, "training_participants"), cs = Object.fromEntries((await this.courses()).map((c) => [c.id, c])); return rs.map((r) => Object.assign({}, r, { course: cs[r.course_id] })).filter((r) => r.course).sort((a, b) => (a.course.start_date < b.course.start_date ? 1 : -1)); }
    async expiring(user, days) { const lim = dates.iso(new Date(+NS.clock.today() + days * 86400000)), today = dates.iso(NS.clock.today()); return (await this.emp.relatedAll(user, "training_participants")).filter((r) => r.certificate_expiry && r.certificate_expiry >= today && r.certificate_expiry <= lim); }
  }
  NS.TrainingService = TrainingService;
})(typeof globalThis !== "undefined" ? globalThis : window);
if (typeof module !== "undefined") module.exports = globalThis.PRDHR;

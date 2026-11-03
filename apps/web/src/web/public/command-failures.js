/** Owner metadata view. No polling, commands, activation or raw diagnostic rendering. */
export function validFailureReport(report) {
  const object = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
  const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
  const tools = ['shell', 'python', 'git', 'zip', 'UNKNOWN_COMMAND'];
  const group = (row, top) => object(row, ['tool', 'category', 'exit', 'count', ...(top ? ['employee_count'] : [])]) &&
    tools.includes(row.tool) && Number.isSafeInteger(row.exit) && row.exit !== 0 && row.exit >= -255 && row.exit <= 255 &&
    row.category === (row.exit === 127 ? 'COMMAND_NOT_FOUND' : row.exit < 0 ? 'SIGNAL' : 'NONZERO') &&
    integer(row.count, top ? 2048 * 64 : 2048) && row.count > 0 && (!top || integer(row.employee_count, 64) && row.employee_count > 0);
  if (!object(report, ['v', 'enabled', 'provenance', 'harness_support', 'employees', 'top_repeats', 'truncated']) ||
      report.v !== 1 || typeof report.enabled !== 'boolean' || report.provenance !== 'SELF_REPORTED_RESULT' ||
      !object(report.harness_support, ['hands', 'claude', 'codex']) || report.harness_support.hands !== 'self_reported' ||
      report.harness_support.claude !== 'unavailable' || report.harness_support.codex !== 'unavailable' ||
      typeof report.truncated !== 'boolean' || !Array.isArray(report.employees) || report.employees.length > 64 ||
      !Array.isArray(report.top_repeats) || report.top_repeats.length > 20 || !report.top_repeats.every(row => group(row, true))) return false;
  const ids = new Set();
  for (const row of report.employees) {
    if (!object(row, ['employee_id', 'harness', 'status', 'counts', 'truncated', 'evicted', 'expired', 'dropped']) ||
        typeof row.employee_id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.employee_id) ||
        ids.has(row.employee_id) || row.harness !== 'hands' || typeof row.truncated !== 'boolean' ||
        !(report.enabled ? ['ready', 'no_data', 'unavailable'] : ['disabled']).includes(row.status) ||
        !Array.isArray(row.counts) || row.counts.length > 20 || !row.counts.every(item => group(item, false)) ||
        new Set(row.counts.map(item => item.tool + ':' + item.exit)).size !== row.counts.length ||
        row.counts.reduce((sum, item) => sum + item.count, 0) > 2048 ||
        !['evicted', 'expired', 'dropped'].every(key => integer(row[key], 2 ** 31 - 1)) ||
        row.status !== 'ready' && (row.counts.length || row.truncated || row.evicted || row.expired || row.dropped)) return false;
    ids.add(row.employee_id);
  }
  return (report.enabled || report.top_repeats.length === 0 && !report.truncated) &&
    new Set(report.top_repeats.map(row => row.tool + ':' + row.exit)).size === report.top_repeats.length &&
    report.top_repeats.every(row => row.employee_count <= ids.size && row.count <= 2048 * ids.size);
}
export class CommandFailureView {
  constructor(doc = document, request = fetch) {
    this.doc = doc; this.request = request; this.generation = 0; this.closed = false; this.names = new Map();
    this.select = doc.getElementById('employee'); this.refresh = doc.getElementById('refresh');
    this.status = doc.getElementById('status'); this.repeats = doc.getElementById('repeats');
    this.employees = doc.getElementById('employees');
    this.refresh.addEventListener('click', () => { void this.load(); });
    this.select.addEventListener('change', () => { void this.load(); });
    doc.defaultView?.addEventListener('pagehide', () => this.close());
    doc.defaultView?.addEventListener('pageshow', event => {
      if (event.persisted) { this.closed = false; void this.load(); }
    });
  }
  close() {
    this.closed = true; this.generation++; this.controller?.abort(); this.clear();
    this.names.clear(); this.select.replaceChildren(this.node('option', 'All employees')); this.select.firstChild.value = '';
  }
  clear() { this.repeats.replaceChildren(); this.employees.replaceChildren(); }
  node(tag, text) { const item = this.doc.createElement(tag); if (text !== undefined) item.textContent = String(text); return item; }
  current(generation) { return !this.closed && generation === this.generation; }
  async json(path, signal) {
    const response = await this.request(path, { credentials: 'same-origin', cache: 'no-store', signal });
    if (response.status === 401 || response.status === 403) throw new Error('owner');
    if (!response.ok) throw new Error('unavailable');
    const value = await response.json();
    if (value?.success !== true || !value.data) throw new Error('unavailable');
    return value.data;
  }
  async load() {
    if (this.closed) return;
    const generation = ++this.generation;
    this.controller?.abort(); this.controller = new AbortController();
    const signal = this.controller.signal;
    this.clear(); this.status.textContent = 'Loading failure metadata…'; this.refresh.disabled = true;
    try {
      // Re-read canonical names on each refresh. They never enter the failure log.
      const company = await this.json('api/company', signal);
      if (!this.current(generation)) return;
      const requested = this.select.value;
      this.names = new Map([...(company.employees || []), ...(company.retired || [])]
        .filter(row => typeof row?.id === 'string').map(row => [row.id, String(row.name || row.id)]));
      this.select.replaceChildren(this.node('option', 'All employees')); this.select.firstChild.value = '';
      for (const [id, name] of this.names) { const option = this.node('option', name); option.value = id; this.select.append(option); }
      this.select.value = this.names.has(requested) ? requested : '';
      if (requested && !this.names.has(requested)) throw new Error('changed');
      const query = requested ? '?employeeId=' + encodeURIComponent(requested) : '';
      const report = await this.json('api/company/command-failures' + query, signal);
      if (!this.current(generation)) return;
      this.render(report);
    } catch (error) {
      if (!this.current(generation)) return;
      this.clear();
      this.status.textContent = error?.message === 'owner' ? 'Sign in as the owner to read command failures.' :
        error?.message === 'changed' ? 'The employee roster changed. Select an employee and refresh.' : 'Failure metadata is unavailable. Refresh to try again.';
      if (error?.message === 'owner') { this.names.clear(); this.select.replaceChildren(this.node('option', 'Sign in as owner')); }
    } finally { if (this.current(generation)) this.refresh.disabled = false; }
  }
  table(rows, top = false) {
    const wrap = this.node('div'); wrap.className = 'table-wrap';
    const table = this.node('table'); const head = this.node('thead'); const headers = this.node('tr');
    for (const text of ['Tool', 'Failure', 'Exit', 'Count', ...(top ? ['Agents'] : [])]) { const th = this.node('th', text); th.scope = 'col'; headers.append(th); }
    head.append(headers); table.append(head); const body = this.node('tbody');
    const categories = { COMMAND_NOT_FOUND: 'Not found', NONZERO: 'Nonzero exit', SIGNAL: 'Signal' };
    for (const row of rows) {
      const tr = this.node('tr');
      for (const value of [row.tool, categories[row.category] || 'Unavailable', row.exit, row.count, ...(top ? [row.employee_count] : [])]) tr.append(this.node('td', value));
      body.append(tr);
    }
    table.append(body); wrap.append(table); return wrap;
  }
  render(report) {
    // Recheck the fixed publication schema; never render raw server diagnostics.
    if (!validFailureReport(report)) throw new Error('unavailable');
    this.clear();
    this.status.textContent = !report.enabled ? 'Logging is off. This view does not enable it.' :
      report.employees.some(row => row.status === 'unavailable') ? 'Some employee metadata is unavailable.' : 'Failure metadata loaded.';
    if (report.top_repeats.length) this.repeats.append(this.table(report.top_repeats, true));
    else this.repeats.append(this.node('p', report.enabled ? 'No repeated failures in the available reports.' : 'Enablement requires the reviewed installation.'));
    if (report.truncated) this.repeats.append(this.node('p', 'Showing the top 20 groups.'));
    for (const row of report.employees) {
      const section = this.node('article'); section.className = 'employee';
      section.append(this.node('h3', this.names.get(row.employee_id) || row.employee_id));
      const messages = { disabled: 'Logging is off.', no_data: 'No failure log has been recorded yet.', unavailable: 'This employee’s metadata is unavailable.', ready: 'Hands · self-reported results' };
      section.append(this.node('p', messages[row.status] || 'Unavailable'));
      if (row.status === 'ready' && row.counts.length) section.append(this.table(row.counts));
      else if (row.status === 'ready') section.append(this.node('p', 'No failures within retention.'));
      if (row.status === 'ready') section.append(this.node('p', `Evicted: ${row.evicted} · Expired: ${row.expired}`));
      if (row.truncated) section.append(this.node('p', 'Showing the top 20 groups for this employee.'));
      this.employees.append(section);
    }
  }
}
if (typeof document !== 'undefined' && document.getElementById('employee')) {
  const view = new CommandFailureView(); void view.load();
}

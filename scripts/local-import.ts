// Explicitly authorized local credential transfer. Existing SDK loader reads the user's
// configuration; this script never prints secret values and never writes the source files.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolveProviderOperation } from '@nb-corp/nb-search';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = resolve(root, '.local');
try {
  const state = JSON.parse(await readFile(resolve(local, 'deployment.json'), 'utf8'));
  const origin = new URL(state.base); if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:') throw Error('LOCAL_TARGET_REQUIRED');
  const credentials = JSON.parse(await readFile(resolve(local, 'admin.json'), 'utf8'));
  const login = await fetch(state.base + '/api/admin/auth/login', { method: 'POST', headers: { origin: state.base, 'content-type': 'application/json' }, body: JSON.stringify(credentials) });
  if (login.status !== 200) throw Error('LOCAL_LOGIN_FAILED');
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!, session = (await login.json()).data;
  async function api(path: string, method = 'GET', input?: unknown) {
    const r = await fetch(state.base + '/api/admin' + path, { method, headers: { origin: state.base, cookie, 'x-csrf-token': session.csrf_token, ...(input === undefined ? {} : { 'content-type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (!r.ok) throw Error(`LOCAL_API_${r.status}`);
    return (await r.json()).data;
  }
  const existing = await api('/providers?limit=100');
  if (existing.items.some((p: any) => p.name.startsWith('Imported: '))) throw Error('LOCAL_IMPORT_ALREADY_PRESENT');
  // This source-only import is deliberate operator tooling, not a private SDK API used by Cloud runtime.
  const loader = await import(pathToFileURL(resolve(root, '../nb-search/src/cli-config.ts')).href);
  const { effective } = loader.resolveCliSnapshot(process.env);
  const report: { source: string; provider_id: string; status: string; lanes?: string[] }[] = [];
  const imported: { source: string; provider_id: string; resource_id: string; lanes: { id: string; kind: string }[] }[] = [];
  const config = effective.config;
  for (const [source, raw] of Object.entries(config.provider_instances)) {
    const instance: any = raw;
    const record = { source, provider_id: instance.provider_id, status: '' };
    if (!['exa', 'grok-multi-agent'].includes(instance.provider_id)) { report.push({ ...record, status: 'skipped-unsupported-provider' }); continue; }
    if (!instance.enabled) { report.push({ ...record, status: 'skipped-disabled' }); continue; }
    const binding = effective.secret_bindings.get(instance.credential_slot_id);
    if (!binding?.value || binding.provider_id !== instance.provider_id || binding.credential_slot_id !== instance.credential_slot_id) { report.push({ ...record, status: 'skipped-no-effective-credential' }); continue; }
    try { resolveProviderOperation(instance.provider_id, instance.provider_id === 'exa' ? 'search' : 'research', instance); }
    catch { report.push({ ...record, status: 'skipped-sdk-configuration-invalid-no-rewrite' }); continue; }
    const compatible = Object.entries(config.lanes).filter(([, rawLane]) => { const lane: any = rawLane; return lane.provider_instance_id === source && (instance.provider_id === 'exa' ? ['search', 'contents'].includes(lane.operation_id) : lane.operation_id === 'research'); });
    if (!compatible.length) { report.push({ ...record, status: 'skipped-no-compatible-lanes' }); continue; }
    const provider = await api('/providers', 'POST', { name: `Imported: ${source}`, provider_id: instance.provider_id, ...(instance.base_url ? { base_url: instance.base_url } : {}), options: instance.options, key_pool: [{ label: 'Imported effective key', secret: binding.value }] });
    const lanes: { id: string; kind: string }[] = [];
    for (const [laneId, rawLane] of compatible) {
      const lane: any = rawLane;
      await api('/lanes', 'POST', { id: laneId, provider_id: provider.id, operation_id: lane.operation_id, latency: lane.latency, cost: lane.cost, evidence_groups: lane.evidence_groups ?? [] });
      lanes.push({ id: laneId, kind: lane.operation_id === 'contents' ? 'fetch' : 'search' });
    }
    imported.push({ source, provider_id: instance.provider_id, resource_id: provider.id, lanes });
    report.push({ ...record, status: 'imported', lanes: lanes.map(l => l.id) });
  }
  if (!imported.length) throw Error('NO_COMPATIBLE_LOCAL_PROVIDER');
  const group = await api('/groups', 'POST', { name: 'Local imported channels', is_exclusive: false, daily_units_per_user: 0 });
  const lanes = imported.flatMap(p => p.lanes);
  await api(`/groups/${group.id}/capabilities`, 'PUT', { expected_revision: group.revision, lanes: lanes.map(l => ({ lane_id: l.id, units_per_query: 1 })), default_search_lane: lanes.find(l => l.id === config.defaults.search_lane)?.id ?? lanes.find(l => l.kind === 'search')?.id ?? null, default_fetch_pipeline: lanes.find(l => l.kind === 'fetch')?.id ?? null, presets: {} });
  const issued = await api('/keys', 'POST', { name: 'Local CLI', group_id: group.id, quota_units: 0 });
  const home = resolve(local, 'client-home'); await mkdir(home, { recursive: true });
  await writeFile(resolve(home, 'profiles.json'), JSON.stringify({ schema_version: '1', profiles: { cloud: { kind: 'remote', base_url: state.base, allow_loopback_http: true, token_env: 'NBCLOUD_LOCAL_TOKEN', timeout_ms: 660000, max_response_bytes: 16777216 } } }, null, 2), { mode: 0o600 });
  await writeFile(resolve(home, 'remote-secrets.json'), JSON.stringify({ schema_version: '1', values: { NBCLOUD_LOCAL_TOKEN: issued.access_key } }), { mode: 0o600 });
  await writeFile(resolve(local, 'import-report.json'), JSON.stringify({ imported, report, group_id: group.id, key_id: issued.key.id }, null, 2));
  await api('/auth/logout', 'POST');
  console.log(JSON.stringify({ event: 'local_import_complete', sources: report, client_home: home }));
} catch {
  console.error('LOCAL_IMPORT_FAILED: no secret values are logged; inspect local service status before retrying.'); process.exitCode = 1;
}

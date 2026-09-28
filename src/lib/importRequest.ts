// "Import" pressed somewhere other than the Transactions grid (e.g. the stale-data banner).
// The flag survives until a Transactions grid mounts or is already listening and takes it.
let pending = false;
export const IMPORT_REQUEST_EVENT = 'finance:import-request';

export function requestImport(): void {
  pending = true;
  window.dispatchEvent(new Event(IMPORT_REQUEST_EVENT));
}

export function takeImportRequest(): boolean {
  const was = pending;
  pending = false;
  return was;
}

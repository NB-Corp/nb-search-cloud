import { readFileSync } from 'node:fs';
// Package metadata beside the public ESM entry, not a private SDK runtime import.
export const CLOUD_SDK_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@nb-corp/nb-search')), 'utf8')).version;
// 0.4.0 retains Exa v1/GMA v2, config schema 4 and existing result/job contracts;
// script/search v1 is additive. Each plan still checks its selected adapter version.
// This explicit admitted family does not authorize future SDK versions automatically.
const compatible = ['0.3.0', '0.3.1', '0.4.0'];
export function compatibleSdkVersion(saved: string, current: string): boolean {
  return saved === current || compatible.includes(saved) && compatible.includes(current);
}

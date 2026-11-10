export type ApprovalValue =
  null | boolean | number | string | ApprovalValue[] | { [key: string]: ApprovalValue };
export function canonicalApprovalPayload(value: ApprovalValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalApprovalPayload).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalApprovalPayload(value[key]!)}`)
    .join(',')}}`;
}

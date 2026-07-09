export type PermissionRefreshReason = "auto" | "manual";

export function isPermissionRecheckBusy(
  refreshReason: PermissionRefreshReason | null,
): boolean {
  return refreshReason === "manual";
}

/**
 * Resolve the Pinout lease/invoke owner for a RAP tool call.
 *
 * RAP `group_id` is the Infinity conversation thread — the default per-thread
 * principal. Callers may still pass MCP-compatible `owner` / `threadId` /
 * `ownerThreadId` in tool arguments for nested scoping.
 */
export function ownerForRapThread(
  groupId: string,
  args: Record<string, unknown> = {},
): string {
  if (typeof args.owner === 'string' && args.owner.length > 0) return args.owner;
  if (typeof args.threadId === 'string' && args.threadId.length > 0) {
    return `${groupId}:${args.threadId}`;
  }
  if (typeof args.ownerThreadId === 'string' && args.ownerThreadId.length > 0) {
    return `${groupId}:${args.ownerThreadId}`;
  }
  return groupId;
}

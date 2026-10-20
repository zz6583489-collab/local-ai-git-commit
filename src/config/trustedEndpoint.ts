/** 只读取用户级设置；工作区配置不得改变 API Key 的发送目标。 */
export function userSetting<T>(
  inspection:
    { globalValue?: T; defaultValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined,
  fallback: T,
): T {
  return inspection?.globalValue ?? inspection?.defaultValue ?? fallback;
}

/** 机械生成的依赖锁文件只用于文件级证据；依赖意图由同批暂存的清单文件判断。 */
export function isDependencyLockfile(path: string): boolean {
  return /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|composer\.lock|Gemfile\.lock)$/.test(
    path,
  );
}

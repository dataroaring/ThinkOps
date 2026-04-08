import { watch, type FSWatcher } from "chokidar";

export function watchFolder(
  path: string,
  onAdd: (filePath: string) => void
): FSWatcher {
  const watcher = watch(path, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 1000 },
  });
  watcher.on("add", onAdd);
  return watcher;
}

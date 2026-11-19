type ScanStage =
  | { stage: "discovery" }
  | { stage: "repository"; current: number; total: number; name: string }
  | { stage: "report"; current: number; total: number; name: string };

export type ScanProgress = ScanStage & { waiting: boolean };
export type ScanProgressListener = (progress: ScanProgress) => void;

export function formatScanProgress(progress: ScanProgress): string {
  const prefix = progress.waiting ? "Still " : "";
  switch (progress.stage) {
    case "discovery":
      return `${prefix}discovering repositories…`;
    case "repository": {
      const name = /^[\w.-]+\/[\w.-]+$/.test(progress.name)
        ? ` (${progress.name})`
        : "";
      return `${prefix}scanning repository ${progress.current}/${progress.total}${name}…`;
    }
    case "report": {
      const name = /^[\w.-]+$/.test(progress.name) ? ` (${progress.name})` : "";
      return `${prefix}writing report ${progress.current}/${progress.total}${name}…`;
    }
  }
}

export function createScanProgress(listener: ScanProgressListener | undefined) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => clearInterval(timer);

  return {
    start(stage: ScanStage) {
      if (!listener) return;
      stop();
      listener({ ...stage, waiting: false });
      // Repeat the current operation during slow requests or rate-limit waits.
      timer = setInterval(
        () => listener({ ...stage, waiting: true }),
        15_000,
      ).unref();
    },
    stop,
  };
}

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { Job } from "./types";

export interface LogLine {
  ts: string;
  level: string;
  message: string;
}

/** Subscribe to a job's SSE stream: accumulates log lines (history replayed by
 * the server first, then live) and pushes status/progress into the job cache. */
export function useJobEvents(id: string) {
  const qc = useQueryClient();
  const [logs, setLogs] = useState<LogLine[]>([]);

  useEffect(() => {
    setLogs([]);
    const es = new EventSource(api.jobEventsUrl(id));

    es.addEventListener("log", (e) => {
      try {
        setLogs((prev) => [...prev, JSON.parse((e as MessageEvent).data) as LogLine]);
      } catch { /* ignore malformed */ }
    });

    es.addEventListener("status", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { status?: Job["status"]; progressPct?: number; stage?: string | null };
        qc.setQueryData<Job>(["job", id], (old) =>
          old
            ? {
                ...old,
                status: d.status ?? old.status,
                progressPct: d.progressPct ?? old.progressPct,
                progressStage: d.stage !== undefined ? d.stage : old.progressStage,
              }
            : old,
        );
      } catch { /* ignore */ }
    });

    es.addEventListener("done", () => {
      es.close();
      qc.invalidateQueries({ queryKey: ["job", id] });
      qc.invalidateQueries({ queryKey: ["job-results", id] });
    });

    return () => es.close();
  }, [id, qc]);

  return logs;
}

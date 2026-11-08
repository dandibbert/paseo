import { useCallback, useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { mergeHistoryTextAnswers, type HistoryTextResult } from "./merge";

const RESULT_LIMIT = 100;

export interface HistoryTextSearch {
  results: HistoryTextResult[];
  isLoading: boolean;
  truncated: boolean;
  /** Hosts whose messages were not searched: offline, failed, or too old to have the index. */
  unsearchedHosts: string[];
}

/**
 * Searches the message text of every chat the hosts have indexed. A chat enters a host's
 * index when a turn of it ends or it is opened, so older chats appear only once opened.
 */
export function useHistoryTextSearch(input: {
  serverId: string | null;
  search: string;
}): HistoryTextSearch {
  const hosts = useHosts();
  const serverIds = useMemo(
    () => (input.serverId ? [input.serverId] : hosts.map((host) => host.serverId)),
    [hosts, input.serverId],
  );
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const supported = useSessionStore(
    useCallback(
      (state) =>
        serverIds
          .filter((id) => state.sessions[id]?.serverInfo?.features?.historyTextSearch === true)
          .join("\n"),
      [serverIds],
    ),
  );
  const labelById = useMemo(
    () => new Map(hosts.map((host) => [host.serverId, host.label])),
    [hosts],
  );
  const targets = useMemo(() => {
    const supportedIds = new Set(supported.split("\n"));
    return serverIds.filter((id) => statuses.get(id) === "online" && supportedIds.has(id));
  }, [serverIds, statuses, supported]);
  const query = input.search.trim();
  const result = useFetchQuery({
    queryKey: ["history-text-search", targets, query],
    enabled: query.length > 0 && targets.length > 0,
    dataShape: "value",
    staleTimeMs: 10_000,
    queryFn: async () => {
      const settled = await Promise.allSettled(
        targets.map(async (serverId) => {
          const client = getHostRuntimeStore().getClient(serverId);
          if (!client) throw new Error("Host disconnected");
          const payload = await client.searchHistoryText({ query, limit: RESULT_LIMIT });
          if (payload.error) throw new Error(payload.error);
          return { serverId, serverLabel: labelById.get(serverId) ?? serverId, payload };
        }),
      );
      const answers = settled.flatMap((entry) =>
        entry.status === "fulfilled" ? [entry.value] : [],
      );
      const failed = targets.filter((_, index) => settled[index]?.status === "rejected");
      return { ...mergeHistoryTextAnswers(answers), failed };
    },
  });
  const unsearchedHosts = useMemo(() => {
    const searched = new Set(targets);
    const failed = new Set(result.data?.failed ?? []);
    return serverIds
      .filter((id) => !searched.has(id) || failed.has(id))
      .map((id) => labelById.get(id) ?? id);
  }, [labelById, result.data?.failed, serverIds, targets]);
  return {
    results: result.data?.results ?? [],
    isLoading: result.isFetching && !result.data,
    truncated: result.data?.truncated ?? false,
    unsearchedHosts,
  };
}

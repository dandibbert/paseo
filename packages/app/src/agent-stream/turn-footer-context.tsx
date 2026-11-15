import { createContext, useContext } from "react";

export interface TurnFooterAgentContextValue {
  serverId: string;
  agentId: string;
  provider: string | null;
  model: string | null;
}

const TurnFooterAgentContext = createContext<TurnFooterAgentContextValue | null>(null);

export const TurnFooterAgentProvider = TurnFooterAgentContext.Provider;

export function useTurnFooterAgentContext(): TurnFooterAgentContextValue | null {
  return useContext(TurnFooterAgentContext);
}

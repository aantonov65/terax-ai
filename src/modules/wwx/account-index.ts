import { useEffect, useState } from "react";
import { ACCOUNT_WORKSPACE, getAccountFixtures } from "./account-fixtures";
import type { WwxIndexState } from "./types";

const EMPTY_INDEX: WwxIndexState = {
  status: "idle",
  workspace: null,
  products: [],
  batches: [],
  refreshedAt: null,
};

export function useWwxIndex(_rootPath: string | null): WwxIndexState {
  const [state, setState] = useState<WwxIndexState>(EMPTY_INDEX);

  useEffect(() => {
    setState((prev) => ({
      ...prev,
      status: "loading",
      workspace: ACCOUNT_WORKSPACE,
    }));

    const timer = window.setTimeout(() => {
      const { products, batches } = getAccountFixtures();
      setState({
        status: "ready",
        workspace: ACCOUNT_WORKSPACE,
        products,
        batches,
        refreshedAt: Date.now(),
      });
    }, 80);

    return () => window.clearTimeout(timer);
  }, []);

  return state;
}

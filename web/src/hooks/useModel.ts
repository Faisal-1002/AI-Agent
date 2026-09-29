import { useEffect, useState } from "react";
import type { ModelInfo } from "../../../shared/chat";
import { api } from "../lib/api";

// Which model the backend is configured to use (shown in the header).
export function useModel(): ModelInfo | undefined {
  const [model, setModel] = useState<ModelInfo>();
  useEffect(() => {
    api.model().then(setModel).catch(() => {});
  }, []);
  return model;
}

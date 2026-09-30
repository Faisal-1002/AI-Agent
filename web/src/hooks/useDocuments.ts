import { useCallback, useEffect, useState } from "react";
import type { DocumentInfo } from "../../../shared/chat";
import { api } from "../lib/api";

// The document library: list, upload, delete — and refresh while anything is still indexing.
export function useDocuments() {
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [error, setError] = useState<string>();

  const refresh = useCallback(() => {
    api.documents().then(setDocuments).catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  const indexing = documents.some((d) => d.status === "indexing");
  useEffect(() => {
    if (!indexing) return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [indexing, refresh]);

  const upload = useCallback(async (files: File[]) => {
    setError(undefined);
    for (const file of files) {
      try {
        const doc = await api.uploadDocument(file);
        setDocuments((list) => [doc, ...list]);
      } catch (err) {
        setError(`${file.name}: ${(err as Error).message}`);
      }
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.deleteDocument(id);
    setDocuments((list) => list.filter((d) => d.id !== id));
  }, []);

  return { documents, error, upload, remove };
}

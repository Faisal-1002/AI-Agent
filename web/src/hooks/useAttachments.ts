import { useCallback, useEffect, useState } from "react";
import { DOCUMENT_TYPES, type AttachedDocument, type ImageAttachment } from "../../../shared/chat";
import { api } from "../lib/api";
import { isImage, prepareImage } from "../lib/images";

const MAX_IMAGES = 4;
const MAX_DOCUMENTS = 5;

// A document attached in the message box. It goes into the library right away; the message
// can be sent once it's indexed ("ready").
export type PendingDocument = {
  key: string;
  name: string;
  status: "uploading" | "indexing" | "ready" | "failed";
  id?: string;
  error?: string;
};

export const isDocument = (file: File) => DOCUMENT_TYPES.includes(file.name.split(".").pop()?.toLowerCase() ?? "");

// What's attached to the message being written: images (sent with it) and documents
// (uploaded to the library, then referenced by the message).
export function useAttachments({ canAttachImages, onHint }: { canAttachImages: boolean; onHint: (hint: string) => void }) {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [documents, setDocuments] = useState<PendingDocument[]>([]);

  const update = (key: string, change: Partial<PendingDocument>) =>
    setDocuments((list) => list.map((d) => (d.key === key ? { ...d, ...change } : d)));

  const addImages = useCallback(
    async (files: File[]) => {
      if (!canAttachImages || files.length === 0) return;
      const usable = files.filter(isImage);
      if (usable.length < files.length) onHint("Only PNG, JPEG, WebP or GIF images can be attached as images.");
      const room = MAX_IMAGES - images.length;
      if (usable.length > room) onHint(`Up to ${MAX_IMAGES} images per message.`);
      const prepared = await Promise.all(usable.slice(0, Math.max(0, room)).map(prepareImage));
      setImages((current) => [...current, ...prepared].slice(0, MAX_IMAGES));
    },
    [canAttachImages, images.length, onHint],
  );

  const addDocuments = useCallback(
    (files: File[]) => {
      const usable = files.filter(isDocument);
      if (usable.length < files.length) onHint(`Documents can be ${DOCUMENT_TYPES.map((t) => t.toUpperCase()).join(", ")}.`);
      const room = MAX_DOCUMENTS - documents.length;
      if (usable.length > room) onHint(`Up to ${MAX_DOCUMENTS} documents per message.`);
      for (const file of usable.slice(0, Math.max(0, room))) {
        const key = crypto.randomUUID();
        setDocuments((list) => [...list, { key, name: file.name, status: "uploading" }]);
        api
          .uploadDocument(file)
          .then((doc) => update(key, { id: doc.id, status: doc.status, error: doc.error }))
          .catch((err: Error) => update(key, { status: "failed", error: err.message }));
      }
    },
    [documents.length, onHint],
  );

  // Pasted or dropped files: images become images (if the model can see them), the rest documents.
  const addFiles = useCallback(
    (files: File[]) => {
      const pictures = canAttachImages ? files.filter(isImage) : [];
      void addImages(pictures);
      const rest = files.filter((f) => !pictures.includes(f));
      if (rest.length) addDocuments(rest);
    },
    [addDocuments, addImages, canAttachImages],
  );

  // While anything is indexing, check the library every 1.5 s.
  const indexing = documents.some((d) => d.status === "indexing");
  useEffect(() => {
    if (!indexing) return;
    const timer = setInterval(() => {
      api
        .documents()
        .then((library) =>
          setDocuments((list) =>
            list.map((d) => {
              const doc = d.status === "indexing" ? library.find((l) => l.id === d.id) : undefined;
              if (!d.id || d.status !== "indexing") return d;
              return doc ? { ...d, status: doc.status, error: doc.error } : { ...d, status: "failed", error: "Deleted from the library" };
            }),
          ),
        )
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [indexing]);

  const ready: AttachedDocument[] = documents.flatMap((d) => (d.status === "ready" && d.id ? [{ id: d.id, name: d.name }] : []));

  return {
    images,
    documents,
    ready,
    waiting: documents.some((d) => d.status === "uploading" || d.status === "indexing"),
    failed: documents.filter((d) => d.status === "failed"),
    addImages,
    addDocuments,
    addFiles,
    removeImage: (index: number) => setImages((list) => list.filter((_, i) => i !== index)),
    removeDocument: (key: string) => setDocuments((list) => list.filter((d) => d.key !== key)),
    // Empty the box after sending; hand the attachments back if the message was refused.
    take: () => {
      const taken = { images, documents };
      setImages([]);
      setDocuments([]);
      return taken;
    },
    restore: (taken: { images: ImageAttachment[]; documents: PendingDocument[] }) => {
      setImages((current) => (current.length ? current : taken.images));
      setDocuments((current) => (current.length ? current : taken.documents));
    },
  };
}

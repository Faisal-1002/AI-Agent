import { FileText, ImageUp, Paperclip } from "lucide-react";
import { useRef } from "react";
import { DOCUMENT_TYPES } from "../../../../shared/chat";
import { IconButton } from "../ui/IconButton";
import { Menu, type MenuItem } from "../ui/Menu";

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const DOCUMENT_ACCEPT = DOCUMENT_TYPES.map((t) => `.${t}`).join(",");

type Props = {
  canAttachImages: boolean; // the model can see images
  onImages: (files: File[]) => void;
  onDocuments: (files: File[]) => void;
};

// 📎 → "Upload image" (sent with the message) or "Upload document" (added to the user's own
// document library and read by the agent for this message), like
// LibreChat's attach menu.
export function AttachMenu({ canAttachImages, onImages, onDocuments }: Props) {
  const imageInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);

  const items: MenuItem[] = [
    ...(canAttachImages
      ? [{ label: "Upload image", hint: "PNG, JPEG, WebP or GIF", icon: ImageUp, onSelect: () => imageInput.current?.click() }]
      : []),
    {
      label: "Upload document",
      hint: "PDF, Word, Markdown, text… · added to your library",
      icon: FileText,
      onSelect: () => documentInput.current?.click(),
    },
  ];

  const picked = (handler: (files: File[]) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    handler([...(e.target.files ?? [])]);
    e.target.value = ""; // picking the same file again still fires onChange
  };

  return (
    <>
      <Menu
        label="Attach"
        items={items}
        trigger={(props) => <IconButton icon={Paperclip} label="Attach files" className="rounded-full" {...props} />}
      />
      <input ref={imageInput} type="file" accept={IMAGE_ACCEPT} multiple className="hidden" onChange={picked(onImages)} />
      <input ref={documentInput} type="file" accept={DOCUMENT_ACCEPT} multiple className="hidden" onChange={picked(onDocuments)} />
    </>
  );
}

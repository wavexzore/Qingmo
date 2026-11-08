import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** One image file selected by paste or drop. */
export interface ImageAttachment {
  file: File;
}

export interface AttachmentsOptions {
  /** Persist each image and return the Markdown to insert, in order. */
  onImageFiles(files: File[]): Promise<string[]>;
}

function imageFiles(data: DataTransfer | null): File[] {
  if (!data) {
    return [];
  }
  const fromFiles = Array.from(data.files ?? []).filter((file) => file.type.startsWith("image/"));
  if (fromFiles.length > 0) {
    return fromFiles;
  }
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/**
 * CM6 extension: paste/drop images into the document.
 *
 * The extension never writes a path itself; the desktop layer supplies the
 * `document_save_image` bridge and returns Markdown. Failed images are simply
 * not inserted, so a partial multi-image paste keeps the successful ones.
 */
export function attachments(options: AttachmentsOptions): Extension {
  const insert = (view: EditorView, files: File[]): boolean => {
    if (files.length === 0) {
      return false;
    }
    void (async () => {
      try {
        const markdown = await options.onImageFiles(files);
        const text = markdown.filter(Boolean).join("\n");
        if (text.length > 0) {
          view.dispatch(view.state.replaceSelection(text));
          view.focus();
        }
      } catch (error) {
        console.warn("failed to persist pasted images", error);
      }
    })();
    return true;
  };

  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = imageFiles(event.clipboardData);
      if (files.length === 0) {
        return false;
      }
      event.preventDefault();
      return insert(view, files);
    },
    drop(event, view) {
      const files = imageFiles(event.dataTransfer);
      if (files.length === 0) {
        return false;
      }
      event.preventDefault();
      return insert(view, files);
    },
  });
}

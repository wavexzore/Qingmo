import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { buildEditorUiCopy } from "../../i18n/editorCopy";
import { normalizeLanguage } from "../../i18n/language";
import type { EditorSession } from "./EditorSession";

/**
 * React binding for the editor's localized copy.
 *
 * It is not a second locale coordinator: the language comes from i18next,
 * which the `LocaleController` already drives. The untitled draft additionally
 * updates its placeholder and snapshot name; named documents only receive the
 * Widget copy.
 */
export function useEditorLocale(session: EditorSession | null): void {
  const { i18n } = useTranslation();
  const language = i18n.language;

  useEffect(() => {
    if (!session) {
      return;
    }
    const supported = normalizeLanguage(language);
    const t = i18n.getFixedT(supported);
    if (session.isUntitled) {
      session.applyPlaceholder(t("editor:empty.placeholder"));
      session.applyUntitledTitle(t("editor:empty.title"));
    }
    session.applyUiCopy(buildEditorUiCopy(supported));
  }, [session, language, i18n]);
}

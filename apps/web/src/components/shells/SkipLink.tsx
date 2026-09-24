// "Skip to main content" — the first focusable element in both shells.
//
// There was no skip link anywhere. On desktop the sidebar renders before
// <main> with up to ~21 links, so a keyboard user tabbed through all of them
// on every page load before reaching the page itself. The link is visually
// hidden until focused; `.skip-link` in globals.css supplies its own visible
// focus style, because this stylesheet otherwise has almost none.
//
// An async server component so the label is translated like the rest of the
// chrome (action.skipToContent).

import { getTranslations } from "next-intl/server";

/** The id both shells put on <main>; the link's only target. */
export const MAIN_CONTENT_ID = "main-content";

export async function SkipLink() {
  const tAction = await getTranslations("action");
  return (
    <a href={`#${MAIN_CONTENT_ID}`} className="skip-link">
      {tAction("skipToContent")}
    </a>
  );
}

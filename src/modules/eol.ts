/**
 * Line endings. Editors (textarea, CodeMirror) work with "\n" only, so a file with Windows "\r\n"
 * looked edited right after opening and was rewritten with "\n" on save. Compare and edit in "\n",
 * write back in the file's own style.
 */
export type Eol = "\n" | "\r\n";
export const eolOf = (text: string): Eol => (text.includes("\r\n") ? "\r\n" : "\n");
export const toLf = (text: string) => text.replace(/\r\n/g, "\n");
export const withEol = (text: string, eol: Eol) => (eol === "\r\n" ? toLf(text).replace(/\n/g, "\r\n") : text);

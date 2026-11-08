/** Links in model output open in the user's browser, and only these kinds. */
export function isOpenableUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

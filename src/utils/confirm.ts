/**
 * Yes/no question with the system dialog. tauri-plugin-dialog replaces `window.confirm`
 * with an async version that returns a Promise (always truthy), so it must be awaited:
 * `if (!window.confirm(...)) return;` would go ahead before the user answers.
 * Also works with the browser's synchronous confirm (plain `npm run dev`).
 */
export async function confirmAsk(message: string): Promise<boolean> {
  const answer = window.confirm(message) as boolean | Promise<boolean>;
  return (await answer) === true;
}

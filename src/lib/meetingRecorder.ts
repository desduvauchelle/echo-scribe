/** Pure decision logic for the manual meeting recorder, kept out of the React
 *  hook so it is unit-testable without a renderer or Tauri. */

export type RecorderAction = "start" | "stop";

/** Given whether a meeting is currently recording, decide what a toggle click
 *  should do: stop it if active, otherwise start a new one. */
export function nextRecorderAction(active: boolean): RecorderAction {
  return active ? "stop" : "start";
}

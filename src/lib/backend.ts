/**
 * The server lives on the same origin as the pages (one process, one port), so REST calls use
 * relative URLs and the WebSocket URL is built from the page's own host.
 */
export function wsOrigin(): string {
  const secure = typeof window !== "undefined" && window.location.protocol === "https:";
  const host = typeof window !== "undefined" ? window.location.host : "localhost:3000";
  return `${secure ? "wss" : "ws"}://${host}`;
}

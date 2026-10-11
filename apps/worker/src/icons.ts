// The icon an instance shows next to its name in apps that list connectors (Claude.ai, ChatGPT) and in
// the server card. The files are the dashboard's own (apps/dashboard/public), served under /dashboard.
// The MCP spec asks clients to support PNG and lets them skip SVG, so the PNG comes first.

export const ICON_PNG_PATH = "/dashboard/icon.png";
export const ICON_SVG_PATH = "/dashboard/favicon.svg";

export function serverIcons(publicUrl: string) {
  return [
    { src: `${publicUrl}${ICON_PNG_PATH}`, mimeType: "image/png", sizes: ["256x256"] },
    { src: `${publicUrl}${ICON_SVG_PATH}`, mimeType: "image/svg+xml", sizes: ["any"] },
  ];
}

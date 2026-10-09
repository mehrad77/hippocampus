// The Worker's own small HTML pages (consent, sign-in errors): no scripts, nothing remote, never framed.

export const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = "body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}label{display:block;margin:.25rem 0}fieldset{border:1px solid #ccc;border-radius:6px}button{font:inherit;padding:.4rem 1rem}";

export function html(status: number, body: string, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  // A second policy on top of the library's frame-ancestors: no scripts or remote content at all.
  headers.append("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hippocampus</title><style>${STYLE}</style>${body}`, { status, headers });
}

export const page = (status: number, title: string, body: string, headers?: Headers) => html(status, `<h1>${escape(title)}</h1>${body}`, headers);

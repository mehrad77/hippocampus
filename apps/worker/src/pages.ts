// The Worker's own small pages (consent, sign-in errors, setup notices): no scripts, nothing remote, never framed.

export const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}label{display:block;margin:.25rem 0}fieldset{border:1px solid #ccc;border-radius:6px;margin:1rem 0}button,input,select{font:inherit}button{padding:.4rem 1rem}.warn{border-left:3px solid #b00;padding-left:.5rem}small{color:#555}";

export function html(status: number, body: string, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  // Not no-referrer: with it, browsers send `Origin: null` on form posts, and the consent form's origin check refuses them.
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  // A second policy on top of the OAuth library's frame-ancestors: no scripts or remote content at all.
  // No form-action: browsers apply it to the redirect after the consent form, which goes to the app.
  headers.append("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hippocampus</title><style>${STYLE}</style>${body}`, { status, headers });
}

export const page = (status: number, title: string, body: string, headers?: Headers) => html(status, `<h1>${escape(title)}</h1>${body}`, headers);

export const plain = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });

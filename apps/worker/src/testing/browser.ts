/** A browser: keeps cookies (by name, ignoring path and domain), doesn't follow redirects. */
export function browser(send: (request: Request) => Promise<Response>) {
  const jar = new Map<string, string>();
  const visit = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await send(new Request(url, { ...init, headers, redirect: "manual" }));
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [name, value] = pair!.split(/=(.*)/s) as [string, string];
      if (!value || attrs.some((a) => /max-age=0/i.test(a.trim()))) jar.delete(name.trim());
      else jar.set(name.trim(), value);
    }
    return res;
  };
  return Object.assign(visit, { jar });
}

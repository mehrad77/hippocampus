import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { href } from "../lib/routes.ts";

const LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
const SAFE = /^(https?:|mailto:|obsidian:|#|\/)/i;

/** Your own notes (human prose from the vault) as markdown. Raw HTML is never rendered; links are allowlisted. */
export function Markdown({ text }: { text: string }) {
  const source = text
    // Obsidian comments and block ids are invisible in Obsidian too.
    .replace(/%%[\s\S]*?%%/g, "")
    .replace(/^\^[\w-]+\s*$/gm, "")
    .replace(LINK, (_m, target: string, alias?: string) => `[${(alias ?? target).trim()}](${href.entity(target.trim())})`);
  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url) => (SAFE.test(url) ? url : "")}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

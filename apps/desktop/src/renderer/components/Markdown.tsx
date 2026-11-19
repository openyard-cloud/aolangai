import { useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/*
 * Agent output is untrusted. Rules (do not relax without review):
 * - no rehype-raw and no HTML strings: raw HTML in the text is dropped, never rendered as elements;
 * - links never navigate the window: a click goes to onOpenLink (main allows http/https only);
 * - images are never fetched: only their alt text is shown.
 */

function CodeBlock({ children }: { children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <button
        className="small md-copy"
        onClick={() => {
          void navigator.clipboard.writeText(pre.current?.innerText ?? "").then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={pre}>{children}</pre>
    </div>
  );
}

export function Markdown({ text, onOpenLink }: { text: string; onOpenLink(url: string): void }) {
  const components: Components = {
    a: ({ href, children }) => (
      <a
        href={href}
        title={href}
        onClick={(e) => {
          e.preventDefault();
          if (href) onOpenLink(href);
        }}
      >
        {children}
      </a>
    ),
    img: ({ alt, src }) => (
      <span className="md-img" title={typeof src === "string" ? src : undefined}>
        [image: {alt || "no description"}]
      </span>
    ),
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  };
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

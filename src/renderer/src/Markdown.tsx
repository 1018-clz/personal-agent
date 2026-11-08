import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

import { isOpenableUrl } from "../../shared/links";

type HastNode = NonNullable<ExtraProps["node"]>;

function textOf(node: HastNode | HastNode["children"][number]): string {
  if (node.type === "text") return node.value;
  return "children" in node ? node.children.map((child) => textOf(child as HastNode)).join("") : "";
}

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href || !isOpenableUrl(href)) return <span className="md-dead-link">{children}</span>;
  return (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        // The window itself never navigates: see will-navigate in the main process.
        event.preventDefault();
        void window.desktop.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

function CodeBlock({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = node ? textOf(node).replace(/\n$/, "") : "";
  const codeElement = node?.children[0];
  const classes = codeElement?.type === "element" ? codeElement.properties.className : undefined;
  const language = Array.isArray(classes)
    ? classes.map(String).find((name) => name.startsWith("language-"))?.slice("language-".length)
    : undefined;

  function copy() {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{language ?? "代码"}</span>
        <button type="button" onClick={copy}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const components: Components = {
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  pre: ({ node, children }) => <CodeBlock node={node}>{children}</CodeBlock>,
  // A remote image would be fetched as soon as it renders, which could leak whatever the
  // model put in its URL. The CSP blocks it anyway; this shows what it was instead.
  img: ({ src, alt }) => {
    const label = `图片：${alt || "无描述"}`;
    return typeof src === "string" ? <Link href={src}>[{label}]</Link> : <span>[{label}]</span>;
  },
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

/**
 * Renders model output. Raw HTML in it stays text: react-markdown never turns it into
 * elements unless a plugin asks it to, and none here does.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

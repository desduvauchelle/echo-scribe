import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mb-2 mt-3 text-base font-semibold text-fg first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-3 text-sm font-semibold text-fg first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-2.5 text-[13px] font-semibold text-fg first:mt-0">{children}</h3>
  ),
  p: ({ children }) => (
    <p className="mb-2 leading-relaxed text-fg last:mb-0">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="mb-2 ml-4 list-disc space-y-1 marker:text-faint last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 ml-4 list-decimal space-y-1 marker:text-faint last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed text-fg">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-line-strong pl-3 text-muted last:mb-0">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => {
    const inline = !className;
    if (inline) {
      return (
        <code className="rounded bg-elevated px-1 py-0.5 font-mono text-[12px] text-fg">
          {children}
        </code>
      );
    }
    return (
      <code className="block overflow-x-auto rounded-md bg-elevated p-2.5 font-mono text-[12px] leading-relaxed text-fg">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <pre className="mb-2 last:mb-0">{children}</pre>,
  hr: () => <hr className="my-3 border-line" />,
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line px-2 py-1 text-left font-semibold text-fg">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-line px-2 py-1 text-muted">{children}</td>
  ),
};

export default function Markdown({ children }: { children: string }) {
  return (
    <div className="text-[13px] text-fg">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

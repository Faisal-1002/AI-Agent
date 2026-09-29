import { isValidElement, memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

const components: Components = {
  // Fenced code blocks: react-markdown gives us <pre><code class="language-x">.
  pre: ({ children }) => {
    const className = isValidElement<{ className?: string }>(children) ? children.props.className : "";
    const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
    return <CodeBlock language={language}>{children}</CodeBlock>;
  },
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

// Renders the assistant's markdown: GitHub-flavored (tables, lists, …) + syntax highlighting.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown prose max-w-none text-[15px] leading-7 prose-p:my-2 prose-pre:m-0 prose-pre:bg-transparent prose-pre:p-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

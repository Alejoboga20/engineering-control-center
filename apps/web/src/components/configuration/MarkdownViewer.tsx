import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * No raw HTML plugin is installed, so HTML in a file stays inert text, and react-markdown drops
 * unsafe link protocols. Images become text so that opening a file cannot contact another server.
 */
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ alt }) => <span className="text-muted">[image{alt ? `: ${alt}` : ''}]</span>,
};

export function MarkdownViewer({ source }: { source: string }) {
  return (
    <div className="markdown" data-testid="markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {source}
      </Markdown>
    </div>
  );
}

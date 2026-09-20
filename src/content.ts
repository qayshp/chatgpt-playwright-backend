import type { Block, Content, Inline } from './types.js';
const escape = (s: string) => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function safeURL(value: string | undefined): string | undefined {
  if (!value) return;
  try { const u = new URL(value); return ['https:','http:','mailto:'].includes(u.protocol) ? u.href : undefined; } catch { return; }
}
function inlineHTML(nodes: Inline[]): string {
  return nodes.map(n=> {
    if (n.type === 'break') return '<br>';
    if (n.type === 'code') return `<code>${escape(n.text)}</code>`;
    if (n.type === 'link') { const url=safeURL(n.url); const text=inlineHTML(n.children); return url?`<a href="${escape(url)}" rel="noreferrer noopener">${text}</a>`:text; }
    if (n.type === 'citation') { const url=safeURL(n.url); return url?`<sup><a href="${escape(url)}" rel="noreferrer noopener">${escape(n.label)}</a></sup>`:`<sup>${escape(n.label)}</sup>`; }
    let text=escape(n.text);
    for (const m of n.marks || []) {const tag={strong:'strong',emphasis:'em',strike:'s'}[m]; if(tag) text=`<${tag}>${text}</${tag}>`;}
    return text;
  }).join('');
}
function blockHTML(blocks: Block[]): string {
  return blocks.map(b=>{
    switch(b.type) {
      case 'paragraph':return `<p>${inlineHTML(b.children)}</p>`;
      case 'heading': {const level=Math.max(1,Math.min(6,Math.trunc(b.level)||1));return `<h${level}>${inlineHTML(b.children)}</h${level}>`;}
      case 'code':return `<pre><code${b.language?` data-language="${escape(b.language)}"`:''}>${escape(b.text)}</code></pre>`;
      case 'list': {const tag=b.ordered?'ol':'ul';return `<${tag}${b.ordered&&b.start?` start="${Math.trunc(b.start)}"`:''}>${b.items.map(i=>`<li>${blockHTML(i)}</li>`).join('')}</${tag}>`;}
      case 'quote':return `<blockquote>${blockHTML(b.children)}</blockquote>`;
      case 'table':return `<table><tbody>${b.rows.map(r=>`<tr>${r.map(c=>`<td>${inlineHTML(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      case 'separator':return '<hr>';
      case 'image':return `<p>[Image: ${escape(b.alt)}]</p>`; // Never auto-load authenticated or remote media.
    }
  }).join('\n');
}
/** Generates allowlisted, escaped HTML from our schema, never from arbitrary page HTML. */
export function renderHTML(content: Content): string { return content.blocks.length?blockHTML(content.blocks):`<p>${escape(content.text).replace(/\n/g,'<br>')}</p>`; }

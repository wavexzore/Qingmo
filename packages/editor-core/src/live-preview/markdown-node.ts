/**
 * Structural subset of Lezer's SyntaxNode used by the Live Preview helpers.
 * Kept in its own module so feature modules can inspect syntax trees without
 * creating a runtime dependency on the decoration planner.
 */
export interface MarkdownNode {
  name: string;
  from: number;
  to: number;
  firstChild: MarkdownNode | null;
  nextSibling: MarkdownNode | null;
  parent: MarkdownNode | null;
}

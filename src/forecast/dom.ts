export type Child = Node | string | null | undefined | false;

/** 用 DOM API 构建节点，账号名等文本一律走 textContent，避免注入 */
export function el(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === '') {
      continue;
    }
    element.append(child);
  }
  return element;
}
